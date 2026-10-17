#!/usr/bin/env python3
"""Independent verifier for DocSeal .dseal packages, format v0.1.

Written from docs/FORMAT-v0.1-DRAFT.md, not from the TypeScript implementation, so that the
two can be compared on the shared test vectors in spec/vectors/. It checks format, integrity,
signatures, trust (pinned keys), and the binding of anchors to the package. It does not
contact Bitcoin: confirmed time proofs are the TypeScript implementation's job.

Usage:
    docseal_verify.py verify PACKAGE [--trust trusted-keys.json] [--json]
    docseal_verify.py vectors SPEC_VECTORS_DIR

Exit codes for `verify`: 0 valid, 1 invalid, 2 indeterminate, 3 error.

Requires the `cryptography` package for Ed25519. No other cryptography is implemented here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import sys
import unicodedata
import zlib
from decimal import Decimal
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MEDIA_TYPE = b"application/vnd.docseal+zip"
SUITE = "ed25519"
PROFILE = "docseal-ed25519-v1"


class FormatError(Exception):
    def __init__(self, code: str, message: str, verdict: str = "invalid") -> None:
        super().__init__(message)
        self.code = code
        self.verdict = verdict


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for part in parts:
        h.update(part)
    return h.digest()


# ---------------------------------------------------------------------------
# Strict I-JSON (RFC 7493)

MAX_JSON_DEPTH = 64


def parse_json(data: bytes) -> Any:
    """Rejects what Python's json module would silently accept: duplicate keys, a BOM,
    lone surrogates, non-finite numbers, and nesting deeper than the format allows."""
    if data.startswith(b"\xef\xbb\xbf"):
        raise FormatError("json", "byte-order mark is not allowed")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise FormatError("json", "invalid UTF-8") from None

    def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise FormatError("json", f"duplicate key {key!r}")
            result[key] = value
        return result

    def finite(token: str) -> float:
        value = float(token)
        if not math.isfinite(value):
            raise FormatError("json", "number out of range")
        return value

    def bounded_int(token: str) -> int:
        # JSON numbers are doubles: an integer beyond the double range is out of range,
        # as it is for every ECMAScript parser.
        value = int(token)
        try:
            float(value)
        except OverflowError:
            raise FormatError("json", "number out of range") from None
        return value

    def reject_constant(token: str) -> None:
        raise FormatError("json", f"{token} is not JSON")

    try:
        value = json.loads(
            text,
            object_pairs_hook=no_duplicates,
            parse_float=finite,
            parse_int=bounded_int,
            parse_constant=reject_constant,
        )
    except FormatError:
        raise
    except (ValueError, RecursionError) as error:
        raise FormatError("json", f"invalid JSON: {error}") from None
    check_json_value(value, 0)
    return value


def check_json_value(value: Any, depth: int) -> None:
    if depth > MAX_JSON_DEPTH:
        raise FormatError("json", "nesting is too deep")
    if isinstance(value, str):
        well_formed(value)
    elif isinstance(value, dict):
        for key, item in value.items():
            well_formed(key)
            check_json_value(item, depth + 1)
    elif isinstance(value, list):
        for item in value:
            check_json_value(item, depth + 1)


def well_formed(text: str) -> None:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise FormatError("json", "lone surrogate in string") from None


# ---------------------------------------------------------------------------
# RFC 8785 JSON Canonicalization Scheme


def jcs(value: Any) -> bytes:
    return canonical(value).encode("utf-8")


def canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return es_number(value)
    if isinstance(value, str):
        # Same escaping as ECMAScript JSON.stringify: \b \f \n \r \t, other C0 as \u00xx.
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be"))  # UTF-16 code unit order
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(value[k]) for k in keys) + "}"
    raise TypeError(f"not JSON: {type(value).__name__}")


def es_number(value: int | float) -> str:
    """ECMAScript Number::toString, which RFC 8785 requires. JSON numbers are doubles in
    I-JSON, so integers outside 2^53 are first rounded to the nearest double."""
    if isinstance(value, int) and abs(value) <= 2**53:
        return str(value)
    x = float(value)
    if not math.isfinite(x):
        raise ValueError("non-finite number")
    if x == 0:
        return "0"
    if x < 0:
        return "-" + es_number(-x)
    # repr() is the shortest round-tripping form, like ECMAScript; only the layout differs.
    sign, digits, exponent = Decimal(repr(x)).as_tuple()
    assert sign == 0 and isinstance(exponent, int)
    s = "".join(map(str, digits)).rstrip("0") or "0"
    exponent += len(digits) - len(s)
    k = len(s)
    n = exponent + k
    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + s
    e = n - 1
    mantissa = s if k == 1 else s[0] + "." + s[1:]
    return f"{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"


# ---------------------------------------------------------------------------
# Encodings

HEX_RE = re.compile(r"^(?:[0-9a-f]{2})*$")
B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def from_hex(text: str, length: int | None = None) -> bytes:
    if not isinstance(text, str) or not HEX_RE.fullmatch(text):
        raise ValueError("expected lowercase hex")
    data = bytes.fromhex(text)
    if length is not None and len(data) != length:
        raise ValueError(f"expected {length} bytes")
    return data


def from_base64url(text: str) -> bytes:
    """Unpadded base64url, canonical only (no padding, no other alphabet, zero trailing bits)."""
    if not isinstance(text, str) or any(c not in B64URL_ALPHABET for c in text) or len(text) % 4 == 1:
        raise ValueError("expected unpadded base64url")
    bits = 0
    buffer = 0
    out = bytearray()
    for char in text:
        buffer = (buffer << 6) | B64URL_ALPHABET.index(char)
        bits += 6
        if bits >= 8:
            bits -= 8
            out.append((buffer >> bits) & 0xFF)
    if buffer & ((1 << bits) - 1):
        raise ValueError("non-canonical base64url")
    return bytes(out)


BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def from_base58(text: str) -> bytes:
    number = 0
    for char in text:
        index = BASE58_ALPHABET.find(char)
        if index < 0:
            raise ValueError("invalid base58")
        number = number * 58 + index
    body = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    leading = len(text) - len(text.lstrip("1"))
    return b"\x00" * leading + body


# ---------------------------------------------------------------------------
# Paths

MAX_PATH_BYTES = 1024
FORBIDDEN_PATH_CHARS = re.compile(r"[\x00-\x1f\x7f\\]")


def validate_path(path: str) -> None:
    def fail(reason: str) -> FormatError:
        return FormatError("path", f"invalid path {path!r}: {reason}")

    if not isinstance(path, str):
        raise fail("not a string")
    try:
        encoded = path.encode("utf-8")
    except UnicodeEncodeError:
        raise fail("lone surrogate") from None
    if unicodedata.normalize("NFC", path) != path:
        raise fail("not in Unicode NFC")
    if FORBIDDEN_PATH_CHARS.search(path):
        raise fail("control character or backslash")
    if len(encoded) > MAX_PATH_BYTES:
        raise fail("too long")
    if any(segment in ("", ".", "..") for segment in path.split("/")):
        raise fail("empty, '.', or '..' segment")


def path_key(path: str) -> bytes:
    return path.encode("utf-8")


def check_path_collisions(paths: list[str]) -> None:
    """Equal under lowercasing or under uppercasing collides; so does a file used as a directory."""
    for fold in (str.lower, str.upper):
        files: set[str] = set()
        directories: set[str] = set()
        for path in paths:
            folded = fold(path)
            if folded in files or folded in directories:
                raise FormatError("path-collision", f"path {path!r} collides with another path")
            files.add(folded)
            segments = folded.split("/")
            for i in range(1, len(segments)):
                directory = "/".join(segments[:i])
                if directory in files:
                    raise FormatError("path-collision", f"path {path!r} uses a file as a directory")
                directories.add(directory)


# ---------------------------------------------------------------------------
# Merkle tree docseal-v1


def leaf_hash(entry: dict[str, Any]) -> bytes:
    fields = {key: entry[key] for key in ("path", "size", "hash", "salt")}
    return sha256(b"\x00", jcs(fields))


def node_hash(left: bytes, right: bytes) -> bytes:
    return sha256(b"\x01", left, right)


def merkle_root(leaves: list[bytes]) -> bytes:
    """RFC 6962 §2.1: split at the largest power of two smaller than n."""
    if not leaves:
        raise ValueError("empty tree")
    if len(leaves) == 1:
        return leaves[0]
    k = 1
    while k * 2 < len(leaves):
        k *= 2
    return node_hash(merkle_root(leaves[:k]), merkle_root(leaves[k:]))


# ---------------------------------------------------------------------------
# Digests

SIGNATURE_DOMAIN = b"DocSeal/v1/signature\x00"
SIGNATURE_SET_DOMAIN = b"DocSeal/v1/signature-set\x00"
ANCHOR_DOMAIN = b"DocSeal/v1/anchor\x00"


def json_hash(value: Any) -> bytes:
    return sha256(jcs(value))


def signed_bytes(protected: Any) -> bytes:
    return SIGNATURE_DOMAIN + json_hash(protected)


def signatures_set_hash(digests: list[bytes]) -> bytes:
    ordered = sorted(digests)
    if len(set(ordered)) != len(ordered):
        raise FormatError("duplicate-signature", "the same signature envelope appears twice")
    return sha256(SIGNATURE_SET_DOMAIN, *ordered)


def seal_digest(statement_hash: bytes, set_hash: bytes) -> bytes:
    return sha256(ANCHOR_DOMAIN, statement_hash, set_hash)


# ---------------------------------------------------------------------------
# Ed25519, profile docseal-ed25519-v1

# y-coordinates (sign bit cleared) of every point of order dividing 8, including the
# non-canonical encodings p and p + 1. Same list as libsodium's has_small_order().
# OpenSSL, behind `cryptography`, accepts some of these keys, and with them a single
# signature verifies any message, so they are rejected before calling it.
SMALL_ORDER_Y = {
    bytes.fromhex(y)
    for y in (
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    )
}


def did_to_public_key(did: str) -> bytes:
    # An Ed25519 did:key has 48 base58 characters; check first, since decoding is quadratic.
    if not isinstance(did, str) or not did.startswith("did:key:z") or len(did) > len("did:key:z") + 64:
        raise ValueError("expected a base58btc Ed25519 did:key")
    data = from_base58(did[len("did:key:z") :])
    if len(data) != 34 or data[:2] != b"\xed\x01":
        raise ValueError("did:key is not an Ed25519 key")
    return data[2:]


def verify_ed25519(signer: str, message: bytes, signature: bytes) -> bool:
    try:
        public_key = did_to_public_key(signer)
    except ValueError:
        return False
    if len(signature) != 64:
        return False
    if public_key[:31] + bytes([public_key[31] & 0x7F]) in SMALL_ORDER_Y:
        return False
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except (InvalidSignature, ValueError):
        return False


# ---------------------------------------------------------------------------
# Data model

HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
UUID_RE = re.compile(r"^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TIME_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?Z$")


def invalid(where: str, message: str) -> FormatError:
    return FormatError("schema", f"{where}: {message}")


def unsupported(where: str, message: str) -> FormatError:
    return FormatError("unsupported", f"{where}: {message}", "unsupported")


def require_object(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise invalid(where, "expected an object")
    return value


def require_string(value: Any, where: str) -> str:
    if not isinstance(value, str):
        raise invalid(where, "expected a string")
    return value


def require_pattern(value: Any, pattern: re.Pattern[str], where: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise invalid(where, f"does not match {pattern.pattern}")
    return value


def require_string_list(value: Any, where: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise invalid(where, "expected an array of strings")
    return value


def require_timestamp(value: Any, where: str) -> None:
    """RFC 3339 in UTC with a real calendar date; leap seconds are rejected."""
    match = TIME_RE.fullmatch(value) if isinstance(value, str) else None
    if match:
        year, month, day, hour, minute, second = map(int, match.groups())
        leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
        days = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        if 1 <= month <= 12 and 1 <= day <= days[month - 1] and hour <= 23 and minute <= 59 and second <= 59:
            return
    raise invalid(where, "expected an RFC 3339 UTC timestamp with a valid date")


def check_header(obj: dict[str, Any], where: str, type_: str) -> None:
    if obj.get("type") != type_:
        raise invalid(f"{where}.type", f"expected {type_!r}")
    if not is_one(obj.get("version")):
        raise unsupported(f"{where}.version", "unsupported version")


def is_one(value: Any) -> bool:
    # JSON 1 and 1.0 are the same number; `True == 1` in Python is not.
    return value is not True and isinstance(value, (int, float)) and value == 1


def check_algorithms(obj: dict[str, Any], where: str) -> None:
    if obj.get("hashAlgorithm") != "sha-256":
        raise unsupported(f"{where}.hashAlgorithm", "only 'sha-256' is supported")
    if obj.get("merkleScheme") != "docseal-v1":
        raise unsupported(f"{where}.merkleScheme", "only 'docseal-v1' is supported")


def parse_manifest(value: Any) -> dict[str, Any]:
    m = require_object(value, "manifest")
    check_header(m, "manifest", "docseal-manifest")
    require_pattern(m.get("packageId"), UUID_RE, "manifest.packageId")
    check_algorithms(m, "manifest")
    if "metadata" in m:
        require_object(m["metadata"], "manifest.metadata")
    if "generator" in m:
        require_string(m["generator"], "manifest.generator")
    files = m.get("files")
    if not isinstance(files, list) or not files:
        raise invalid("manifest.files", "must be a non-empty array")
    previous: bytes | None = None
    for i, item in enumerate(files):
        where = f"manifest.files[{i}]"
        entry = require_object(item, where)
        path = require_string(entry.get("path"), f"{where}.path")
        validate_path(path)
        if previous is not None and path_key(path) <= previous:
            raise invalid(f"{where}.path", "files must be sorted by UTF-8 bytes, without duplicates")
        previous = path_key(path)
        size = entry.get("size")
        if isinstance(size, bool) or not isinstance(size, (int, float)) or size != int(size) or not 0 <= size <= 2**53 - 1:
            raise invalid(f"{where}.size", "expected a non-negative safe integer")
        require_pattern(entry.get("hash"), HEX64, f"{where}.hash")
        require_pattern(entry.get("salt"), HEX32, f"{where}.salt")
        if "mediaType" in entry:
            require_string(entry["mediaType"], f"{where}.mediaType")
    check_path_collisions([entry["path"] for entry in files])
    return m


def parse_statement(value: Any) -> dict[str, Any]:
    s = require_object(value, "statement")
    check_header(s, "statement", "docseal-package-statement")
    critical = require_string_list(s.get("critical"), "statement.critical")
    if critical:
        raise unsupported("statement.critical", f"unknown critical extensions: {', '.join(critical)}")
    require_pattern(s.get("packageId"), UUID_RE, "statement.packageId")
    check_algorithms(s, "statement")
    require_pattern(s.get("merkleRoot"), HEX64, "statement.merkleRoot")
    require_pattern(s.get("manifestHash"), HEX64, "statement.manifestHash")
    require_timestamp(s.get("createdAt"), "statement.createdAt")
    if "previous" not in s or s["previous"] is not None:
        raise unsupported("statement.previous", "package versions are not supported in v0.1")
    policy = require_object(s.get("signaturePolicy"), "statement.signaturePolicy")
    if policy.get("type") != "any-valid":
        raise unsupported("statement.signaturePolicy.type", "only 'any-valid' is supported in v0.1")
    return s


def parse_envelope(value: Any) -> dict[str, Any]:
    e = require_object(value, "envelope")
    require_string(e.get("value"), "envelope.value")
    p = require_object(e.get("protected"), "envelope.protected")
    if p.get("type") != "docseal-signature":
        raise invalid("envelope.protected.type", "expected 'docseal-signature'")
    if not is_one(p.get("version")):
        raise unsupported("envelope.protected.version", "unsupported version")
    for field in ("suite", "profile", "signer"):
        require_string(p.get(field), f"envelope.protected.{field}")
    if "role" in p:
        require_string(p["role"], "envelope.protected.role")
    require_timestamp(p.get("claimedAt"), "envelope.protected.claimedAt")
    require_pattern(p.get("statementHash"), HEX64, "envelope.protected.statementHash")
    if "attributes" in p:
        require_object(p["attributes"], "envelope.protected.attributes")
    require_string_list(p.get("critical"), "envelope.protected.critical")
    return e


def parse_anchor(value: Any) -> dict[str, Any]:
    a = require_object(value, "anchor")
    check_header(a, "anchor", "docseal-anchor")
    require_pattern(a.get("seal"), HEX64, "anchor.seal")
    require_pattern(a.get("statementHash"), HEX64, "anchor.statementHash")
    for i, digest in enumerate(require_string_list(a.get("envelopes"), "anchor.envelopes")):
        require_pattern(digest, HEX64, f"anchor.envelopes[{i}]")
    receipts = a.get("receipts")
    if not isinstance(receipts, list) or not receipts:
        raise invalid("anchor.receipts", "must contain at least one receipt")
    for i, item in enumerate(receipts):
        where = f"anchor.receipts[{i}]"
        r = require_object(item, where)
        require_string(r.get("provider"), f"{where}.provider")
        require_string(r.get("network"), f"{where}.network")
        if r.get("digestAlgorithm") != "sha-256":
            raise unsupported(f"{where}.digestAlgorithm", "only 'sha-256' is supported")
        require_pattern(r.get("digest"), HEX64, f"{where}.digest")
        require_string(r.get("proof"), f"{where}.proof")
        if "cached" in r:
            require_object(r["cached"], f"{where}.cached")
    return a


# ---------------------------------------------------------------------------
# Container

MiB = 1024 * 1024
GiB = 1024 * MiB
LIMITS = {
    "max_entries": 10_100,
    "max_document_size": 16 * GiB,
    "max_total_document_size": 64 * GiB,
    "max_json_size": 16 * MiB,
    "max_compression_ratio": 1000,
    "max_central_directory_size": 64 * MiB,
}
SIGNATURE_NAME = re.compile(r"^signatures/[0-9]{4,}\.json$")
ANCHOR_NAME = re.compile(r"^anchors/seal-[1-9][0-9]*\.json$")
M16, M32 = 0xFFFF, 0xFFFFFFFF
ZIP64_EXTRA, UNICODE_PATH_EXTRA = 0x0001, 0x7075


def locate_central_directory(data: bytes) -> tuple[int, int, int]:
    """Returns (offset, size, entry count), from the ZIP64 records when a locator is present."""
    end = find_end_of_central_directory(data)
    disk, cd_disk, on_disk, total, cd_size, cd_offset = struct.unpack_from("<HHHHII", data, end + 4)
    locator = end - 20
    if locator < 0 or data[locator : locator + 4] != b"PK\x06\x07":
        if M16 in (disk, cd_disk, on_disk, total) or M32 in (cd_size, cd_offset):
            raise FormatError("zip", "end of central directory refers to a missing ZIP64 record")
        if disk != 0 or cd_disk != 0 or on_disk != total:
            raise FormatError("zip", "multi-disk archives are not supported")
        if cd_offset + cd_size != end:
            raise FormatError("zip", "unexpected data around the central directory")
        return cd_offset, cd_size, total
    record_disk, record, total_disks = struct.unpack_from("<IQI", data, locator + 4)
    if record_disk != 0 or total_disks > 1:
        raise FormatError("zip", "multi-disk archives are not supported")
    if record + 56 != locator or data[record : record + 4] != b"PK\x06\x06":
        raise FormatError("zip", "corrupt ZIP64 end of central directory")
    (record_size, _made, _needed, disk64, cd_disk64, on_disk64, total64, size64, offset64) = struct.unpack_from("<QHHIIQQQQ", data, record + 4)
    if record_size != 44:
        raise FormatError("zip", "ZIP64 end of central directory has extensible data")
    pairs = ((disk, M16, disk64), (cd_disk, M16, cd_disk64), (on_disk, M16, on_disk64), (total, M16, total64), (cd_size, M32, size64), (cd_offset, M32, offset64))
    if any(value not in (marker, actual) for value, marker, actual in pairs):
        raise FormatError("zip", "end of central directory disagrees with the ZIP64 record")
    if disk64 != 0 or cd_disk64 != 0 or on_disk64 != total64:
        raise FormatError("zip", "multi-disk archives are not supported")
    if offset64 + size64 != record:
        raise FormatError("zip", "unexpected data around the central directory")
    return offset64, size64, total64


def parse_extra(extra: bytes, name: str) -> dict[int, bytes]:
    blocks: dict[int, bytes] = {}
    pos = 0
    while pos < len(extra):
        if pos + 4 > len(extra):
            raise FormatError("zip", f"corrupt extra field in {name!r}")
        block_id, length = struct.unpack_from("<HH", extra, pos)
        if pos + 4 + length > len(extra) or block_id in blocks:
            raise FormatError("zip", f"corrupt extra field in {name!r}")
        if block_id == UNICODE_PATH_EXTRA:
            raise FormatError("zip", f"entry {name!r} carries a second name in a Unicode Path extra field")
        blocks[block_id] = extra[pos + 4 : pos + 4 + length]
        pos += 4 + length
    return blocks


def read_container(data: bytes) -> dict[str, Any]:
    """Parses the ZIP central directory itself, like the specification requires, instead of
    trusting zipfile: duplicate names, symlinks, overlaps, and declared sizes all matter."""
    cd_offset, cd_size, total = locate_central_directory(data)
    if total > LIMITS["max_entries"]:
        raise FormatError("limit", "too many entries")
    if cd_size > LIMITS["max_central_directory_size"]:
        raise FormatError("limit", "central directory is too large")
    cd_end = cd_offset + cd_size

    entries = []
    names: set[str] = set()
    pos = cd_offset
    for _ in range(total):
        if pos + 46 > cd_end or data[pos : pos + 4] != b"PK\x01\x02":
            raise FormatError("zip", "corrupt central directory")
        (made_by, _needed, flags, method, _time, _date, crc, compressed, size, name_len, extra_len, comment_len, disk_start, _internal, external, local_offset) = struct.unpack_from("<HHHHHHIIIHHHHHII", data, pos + 4)
        name_bytes = data[pos + 46 : pos + 46 + name_len]
        extra = data[pos + 46 + name_len : pos + 46 + name_len + extra_len]
        pos += 46 + name_len + extra_len + comment_len
        if pos > cd_end:
            raise FormatError("zip", "corrupt central directory")
        name = decode_name(name_bytes, flags)
        if name in names:
            raise FormatError("duplicate-entry", f"duplicate entry {name!r}")
        names.add(name)
        # The ZIP64 block holds exactly the fields whose header value is the marker, in order.
        zip64 = parse_extra(extra, name).get(ZIP64_EXTRA)
        fields = []
        if size == M32:
            fields.append(("size", "Q"))
        if compressed == M32:
            fields.append(("compressed", "Q"))
        if local_offset == M32:
            fields.append(("local_offset", "Q"))
        if disk_start == M16:
            fields.append(("disk_start", "I"))
        layout = "<" + "".join(kind for _, kind in fields)
        if (zip64 is None and fields) or (zip64 is not None and len(zip64) != struct.calcsize(layout)):
            raise FormatError("zip", f"ZIP64 fields of {name!r} do not match its header")
        values = dict(zip((field for field, _ in fields), struct.unpack(layout, zip64))) if zip64 is not None else {}
        size = values.get("size", size)
        compressed = values.get("compressed", compressed)
        local_offset = values.get("local_offset", local_offset)
        if values.get("disk_start", disk_start) != 0:
            raise FormatError("zip", "multi-disk archives are not supported")
        if flags & 0x0001:
            raise FormatError("zip", f"entry {name!r} is encrypted")
        if flags & 0x0008:
            raise FormatError("zip", f"entry {name!r} uses a data descriptor")
        if method not in (0, 8):
            raise FormatError("zip", f"entry {name!r} uses compression method {method}", "unsupported")
        if made_by >> 8 == 3:  # Unix: the high 16 bits of the external attributes are st_mode
            file_type = (external >> 16) & 0o170000
            allowed = 0o040000 if name.endswith("/") else 0o100000
            if file_type not in (0, allowed):
                raise FormatError("entry-type", f"entry {name!r} is a symlink or special file")
        if (compressed != size) if method == 0 else size > max(compressed, 1) * LIMITS["max_compression_ratio"]:
            raise FormatError("limit", f"entry {name!r} exceeds the compression ratio limit")
        entries.append({"name": name, "name_bytes": name_bytes, "flags": flags, "method": method, "crc": crc, "compressed": compressed, "size": size, "offset": local_offset})
    if pos != cd_end:
        raise FormatError("zip", "corrupt central directory")

    for entry in entries:
        offset = entry["offset"]
        if offset + 30 > cd_offset or data[offset : offset + 4] != b"PK\x03\x04":
            raise FormatError("zip", f"corrupt local header for {entry['name']!r}")
        local_flags, local_method, _t, _d, local_crc, local_compressed, local_size, name_len, extra_len = struct.unpack_from("<HHHHIIIHH", data, offset + 6)
        if offset + 30 + name_len + extra_len > cd_offset:
            raise FormatError("zip", f"corrupt local header for {entry['name']!r}")
        if data[offset + 30 : offset + 30 + name_len] != entry["name_bytes"]:
            raise FormatError("zip", f"local and central names differ for {entry['name']!r}")
        # Sizes are either both in the header, or both markers with the values in a ZIP64 block.
        zip64 = parse_extra(data[offset + 30 + name_len : offset + 30 + name_len + extra_len], entry["name"]).get(ZIP64_EXTRA)
        if local_size == M32 and local_compressed == M32 and zip64 is not None and len(zip64) == 16:
            local_size, local_compressed = struct.unpack("<QQ", zip64)
        elif M32 in (local_size, local_compressed) or zip64 is not None:
            raise FormatError("zip", f"corrupt ZIP64 sizes in the local header of {entry['name']!r}")
        if (local_flags, local_method, local_crc, local_compressed, local_size) != (entry["flags"], entry["method"], entry["crc"], entry["compressed"], entry["size"]):
            raise FormatError("zip", f"local header of {entry['name']!r} disagrees with the central directory")
        entry["data_offset"] = offset + 30 + name_len + extra_len
        if entry["data_offset"] + entry["compressed"] > cd_offset:
            raise FormatError("zip", f"entry {entry['name']!r} extends past the central directory")
    # Entries must tile the archive from 0 to the central directory: no overlaps, no gaps.
    expected_offset = 0
    for start, stop in sorted((e["offset"], e["data_offset"] + e["compressed"]) for e in entries):
        if start != expected_offset:
            raise FormatError("zip", "entries overlap" if start < expected_offset else "unaccounted data between entries")
        expected_offset = stop
    if expected_offset != cd_offset:
        raise FormatError("zip", "unaccounted data before the central directory")

    first = entries[0] if entries else None
    if first is None or first["name"] != "mimetype" or first["method"] != 0 or first["offset"] != 0:
        raise FormatError("mimetype", "'mimetype' must be the first entry, stored without compression")

    contents: dict[str, Any] = {"manifest": None, "statement": None, "files": {}, "signatures": {}, "anchors": {}}
    classified = [(entry, *classify(entry["name"])) for entry in entries]
    total_documents = 0
    for entry, kind, _ in classified:  # every declared size is checked before inflating anything
        max_size = LIMITS["max_document_size"] if kind == "files" else LIMITS["max_json_size"]
        if entry["size"] > max_size:
            raise FormatError("limit", f"entry {entry['name']!r} exceeds the size limit")
        if kind == "files":
            total_documents += entry["size"]
        if kind == "directory" and entry["size"] != 0:
            raise FormatError("entry", f"directory entry {entry['name']!r} has contents")
    if total_documents > LIMITS["max_total_document_size"]:
        raise FormatError("limit", "documents exceed the total size limit")
    for entry, kind, key in classified:
        if kind == "directory":
            continue
        content = extract(data, entry)
        if kind == "mimetype":
            if content != MEDIA_TYPE:
                raise FormatError("mimetype", f"'mimetype' must contain {MEDIA_TYPE.decode()}")
        elif kind in ("manifest", "statement"):
            contents[kind] = content
        else:
            contents[kind][key] = content
    if contents["manifest"] is None or contents["statement"] is None:
        raise FormatError("missing-entry", "'manifest.json' and 'statement.json' are required")
    check_path_collisions(list(contents["files"]))
    return contents


def find_end_of_central_directory(data: bytes) -> int:
    for pos in range(len(data) - 22, max(-1, len(data) - 22 - 0xFFFF - 1), -1):
        if data[pos : pos + 4] == b"PK\x05\x06":
            (comment_len,) = struct.unpack_from("<H", data, pos + 20)
            if pos + 22 + comment_len == len(data):
                return pos
    raise FormatError("zip", "not a ZIP archive")


def decode_name(name: bytes, flags: int) -> str:
    if not flags & 0x0800 and any(byte >= 0x80 for byte in name):
        raise FormatError("entry-name", "non-ASCII entry names must be flagged as UTF-8")
    try:
        return name.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise FormatError("entry-name", "entry name is not valid UTF-8") from None


def classify(name: str) -> tuple[str, str]:
    if name == "mimetype":
        return "mimetype", name
    if name in ("manifest.json", "statement.json"):
        return name.removesuffix(".json"), name
    if name in ("files/", "signatures/", "anchors/"):
        return "directory", name
    if name.startswith("files/"):
        path = name[len("files/") :]
        if path.endswith("/"):
            validate_path(path[:-1])
            return "directory", name
        validate_path(path)
        return "files", path
    if SIGNATURE_NAME.fullmatch(name):
        return "signatures", name
    if ANCHOR_NAME.fullmatch(name):
        return "anchors", name
    raise FormatError("unexpected-entry", f"unexpected entry {name!r}")


def extract(data: bytes, entry: dict[str, Any]) -> bytes:
    raw = data[entry["data_offset"] : entry["data_offset"] + entry["compressed"]]
    content = raw if entry["method"] == 0 else inflate(raw, entry)
    if zlib.crc32(content) != entry["crc"]:
        raise FormatError("zip", f"entry {entry['name']!r} fails its CRC-32 check")
    return content


def inflate(raw: bytes, entry: dict[str, Any]) -> bytes:
    try:
        # One spare byte shows an entry longer than declared, without inflating all of it.
        content = zlib.decompressobj(-15).decompress(raw, entry["size"] + 1)
    except zlib.error:
        raise FormatError("zip", f"entry {entry['name']!r} is not valid deflate data") from None
    if len(content) != entry["size"]:
        raise FormatError("zip", f"entry {entry['name']!r} does not match its declared size")
    return content


# ---------------------------------------------------------------------------
# Verification


def verify_package(data: bytes, trusted: dict[str, str] | None = None) -> dict[str, Any]:
    axes = {
        "format": "valid",
        "integrity": "not-checked",
        "signature": "missing",
        "trust": "not-evaluated",
        "time": "missing",
        "completeness": "incomplete",
    }
    report: dict[str, Any] = {"axes": axes, "files": [], "signatures": [], "anchors": [], "issues": []}

    def issue(axis: str, code: str, message: str, subject: str | None = None) -> None:
        report["issues"].append({"axis": axis, "code": code, "message": message, **({"subject": subject} if subject else {})})

    try:
        contents = read_container(data)
        manifest = parse_manifest(parse_json(contents["manifest"]))
        statement = parse_statement(parse_json(contents["statement"]))
    except FormatError as error:
        axes["format"] = error.verdict
        issue("format", error.code, str(error))
        return finish(report)

    statement_hash = json_hash(statement)
    report["packageId"] = statement["packageId"]
    report["statementHash"] = statement_hash.hex()

    # Integrity
    integrity_issues = len(report["issues"])
    files_complete = True
    if json_hash(manifest).hex() != statement["manifestHash"]:
        issue("integrity", "manifest-hash", "manifest.json does not match statement.manifestHash")
    if manifest["packageId"] != statement["packageId"]:
        issue("integrity", "package-id", "manifest and statement have different packageId")
    if merkle_root([leaf_hash(entry) for entry in manifest["files"]]).hex() != statement["merkleRoot"]:
        issue("integrity", "merkle-root", "Merkle root does not match statement.merkleRoot")
    listed = set()
    for entry in manifest["files"]:
        listed.add(entry["path"])
        content = contents["files"].get(entry["path"])
        if content is None:
            files_complete = False
            report["files"].append({"path": entry["path"], "status": "missing"})
            issue("integrity", "missing-file", "file listed in the manifest is missing", entry["path"])
        elif len(content) != entry["size"] or sha256(content).hex() != entry["hash"]:
            report["files"].append({"path": entry["path"], "status": "modified"})
            issue("integrity", "modified-file", "file contents do not match the manifest", entry["path"])
        else:
            report["files"].append({"path": entry["path"], "status": "valid"})
    for path in contents["files"]:
        if path not in listed:
            report["files"].append({"path": path, "status": "extra"})
            issue("integrity", "extra-file", "file is not listed in the manifest", path)
    axes["integrity"] = "valid" if len(report["issues"]) == integrity_issues else "invalid"

    # Signatures
    digests = []
    valid_signers = []
    for name, raw in contents["signatures"].items():
        try:
            envelope = parse_envelope(parse_json(raw))
        except FormatError as error:
            report["signatures"].append({"entry": name, "check": error.verdict})
            issue("signature", error.code, str(error), name)
            continue
        digests.append(json_hash(envelope))
        header = envelope["protected"]
        result = {"entry": name, "check": "invalid", "signer": header["signer"], "suite": header["suite"], "profile": header["profile"]}
        report["signatures"].append(result)
        if header["critical"]:
            result["check"] = "unsupported"
            issue("signature", "critical", "unknown critical extensions", name)
        elif header["suite"] != SUITE or header["profile"] != PROFILE:
            result["check"] = "unsupported"
            issue("signature", "unsupported-suite", f"no suite for {header['suite']}/{header['profile']}", name)
        elif header["statementHash"] != statement_hash.hex():
            issue("signature", "statement-hash", "signature is for a different statement", name)
        else:
            try:
                value = from_base64url(envelope["value"])
            except ValueError:
                issue("signature", "encoding", "signature value is not valid base64url", name)
                continue
            if verify_ed25519(header["signer"], signed_bytes(header), value):
                result["check"] = "valid"
                valid_signers.append(result)
            else:
                issue("signature", "bad-signature", "signature does not verify", name)
    duplicate = False
    try:
        signatures_set_hash(digests)
    except FormatError as error:
        duplicate = True
        issue("signature", error.code, str(error), "signatures/")
    checks = [s["check"] for s in report["signatures"]]
    if duplicate or "invalid" in checks:
        axes["signature"] = "invalid"
    elif valid_signers:
        axes["signature"] = "valid"
    elif "unsupported" in checks:
        axes["signature"] = "unsupported"
    else:
        axes["signature"] = "missing"
    signatures_complete = "unsupported" not in checks

    # Anchors: binding only; a bound proof cannot be confirmed offline.
    time_complete = True
    seal = None
    try:
        seal = seal_digest(statement_hash, signatures_set_hash(digests))
        report["seal"] = seal.hex()
    except FormatError:
        pass
    anchors = contents["anchors"]
    if len(anchors) > 1:
        axes["time"] = "invalid"
        issue("time", "anchors", "v0.1 packages have at most one anchor file", "anchors/")
    elif anchors:
        verdicts = []
        for name, raw in anchors.items():
            try:
                anchor = parse_anchor(parse_json(raw))
            except FormatError as error:
                verdicts.append(error.verdict)
                issue("time", error.code, str(error), name)
                continue
            expected = sorted(d.hex() for d in digests)
            if seal is None or anchor["seal"] != seal.hex() or anchor["statementHash"] != statement_hash.hex() or anchor["envelopes"] != expected:
                verdicts.append("invalid")
                issue("time", "seal", "anchor does not cover this statement and these signatures", name)
                continue
            for receipt in anchor["receipts"]:
                if receipt["digest"] != anchor["seal"]:
                    verdicts.append("invalid")
                    issue("time", "invalid", "receipt is for a different digest", name)
                else:
                    verdicts.append("unsupported")
                    report["anchors"].append({"entry": name, "provider": receipt["provider"], "verdict": "unsupported"})
        axes["time"] = "invalid" if "invalid" in verdicts else "pending" if "pending" in verdicts else "unsupported"
        time_complete = "unsupported" not in verdicts

    # Trust
    if trusted is not None and axes["signature"] == "valid":
        verdicts = []
        for result in valid_signers:
            result["trust"] = "trusted" if result["signer"] in trusted else "untrusted"
            verdicts.append(result["trust"])
        # Every valid signer must be trusted, or a stranger's signature borrows the author's trust.
        axes["trust"] = "trusted" if all(v == "trusted" for v in verdicts) else "untrusted"

    axes["completeness"] = "full" if files_complete and signatures_complete and time_complete else "incomplete"
    return finish(report)


def finish(report: dict[str, Any]) -> dict[str, Any]:
    axes = report["axes"]
    if "invalid" in (axes["format"], axes["integrity"], axes["signature"], axes["time"]):
        overall = "invalid"
    elif axes == {"format": "valid", "integrity": "valid", "signature": "valid", "trust": "trusted", "time": "confirmed", "completeness": "full"}:
        overall = "valid"
    else:
        overall = "indeterminate"
    return {"overall": overall, **report}


def load_trusted_keys(path: Path) -> dict[str, str]:
    data = parse_json(path.read_bytes())
    if not isinstance(data, dict) or data.get("type") != "docseal-trusted-keys" or not is_one(data.get("version")):
        raise FormatError("trusted-keys", "not a DocSeal trusted keys file (version 1)")
    keys: dict[str, str] = {}
    for item in data.get("keys", []):
        key_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(key_id, str) or not key_id or key_id in keys:
            raise FormatError("trusted-keys", "every key needs a unique non-empty id")
        keys[key_id] = item.get("label", "")
    return keys


# ---------------------------------------------------------------------------
# Test vectors


def run_vectors(directory: Path) -> int:
    failures: list[str] = []
    count = 0

    def check(condition: bool, name: str) -> None:
        nonlocal count
        count += 1
        if not condition:
            failures.append(name)

    def load(name: str) -> Any:
        return json.loads((directory / name).read_text("utf-8"))

    for case in load("jcs.json")["cases"]:
        check(jcs(parse_json(case["input"].encode())).decode() == case["canonical"], f"jcs {case['input'][:40]}")

    paths = load("paths.json")
    for path in paths["valid"]:
        try:
            validate_path(path)
            check(True, "")
        except FormatError:
            check(False, f"path should be valid: {path[:40]!r}")
    for case in paths["invalid"]:
        try:
            validate_path(case["path"])
            check(False, f"path should be invalid ({case['reason']}): {case['path'][:40]!r}")
        except FormatError:
            check(True, "")
    check(sorted(paths["sort"]["input"], key=path_key) == paths["sort"]["expected"], "path sort order")
    for case in paths["collisions"]:
        try:
            check_path_collisions(case["paths"])
            collides = False
        except FormatError:
            collides = True
        check(collides == case["collides"], f"collision {case['paths']}")

    for case in load("merkle.json")["cases"]:
        leaves = [leaf_hash(entry) for entry in case["files"]]
        check([leaf.hex() for leaf in leaves] == case["leafHashes"], f"merkle leaves: {case['name']}")
        check(merkle_root(leaves).hex() == case["root"], f"merkle root: {case['name']}")

    signatures = load("signature.json")
    example = signatures["example"]
    check(jcs(example["protected"]).decode() == example["jcs"], "signature example JCS")
    check(json_hash(example["protected"]).hex() == example["protectedHash"], "signature example hash")
    check(signed_bytes(example["protected"]).hex() == example["signedBytes"], "signature example signed bytes")
    check(did_to_public_key(signatures["did"]).hex() == signatures["publicKey"], "did:key decoding")
    check({bytes.fromhex(y) for y in signatures["smallOrderY"]} == SMALL_ORDER_Y, "small-order list")
    for case in signatures["cases"]:
        result = verify_ed25519(case["signer"], signed_bytes(case["protected"]), from_base64url(case["signature"]))
        check(result == case["valid"], f"signature: {case['name']}")

    seal = load("seal.json")
    statement_hash = json_hash(seal["statement"])
    digests = [json_hash(envelope) for envelope in seal["envelopes"]]
    check(json_hash(seal["manifest"]).hex() == seal["manifestHash"] == seal["statement"]["manifestHash"], "seal: manifestHash")
    check(merkle_root([leaf_hash(e) for e in seal["manifest"]["files"]]).hex() == seal["statement"]["merkleRoot"], "seal: merkleRoot")
    check(statement_hash.hex() == seal["statementHash"], "seal: statementHash")
    check([d.hex() for d in digests] == seal["envelopeDigests"], "seal: envelope digests")
    check(signatures_set_hash(digests).hex() == seal["signaturesSetHash"], "seal: signaturesSetHash")
    check(seal_digest(statement_hash, signatures_set_hash(digests)).hex() == seal["seal"], "seal: seal")

    for case in load("packages/expected.json")["packages"]:
        report = verify_package((directory / "packages" / case["file"]).read_bytes())
        actual = {"axes": report["axes"], "overall": report["overall"]}
        check(actual == case["expected"], f"package {case['file']}: got {actual}, expected {case['expected']}")

    for failure in failures:
        print(f"FAIL {failure}")
    print(f"{count - len(failures)} of {count} checks passed")
    return 0 if not failures else 1


# ---------------------------------------------------------------------------


UNSAFE_CHARS = re.compile("[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]")


def sanitize(text: str) -> str:
    """Escapes controls and bidirectional marks, so package text cannot redraw the terminal."""
    return UNSAFE_CHARS.sub(lambda m: f"\\u{ord(m.group()):04x}", text)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="docseal_verify.py", description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify", help="verify a .dseal package offline")
    verify.add_argument("package", type=Path)
    verify.add_argument("--trust", type=Path, help="trusted-keys.json")
    verify.add_argument("--json", action="store_true", help="print the report as JSON")
    vectors = commands.add_parser("vectors", help="check the shared test vectors")
    vectors.add_argument("directory", type=Path)
    args = parser.parse_args(argv)

    try:
        if args.command == "vectors":
            return run_vectors(args.directory)
        trusted = load_trusted_keys(args.trust) if args.trust else None
        report = verify_package(args.package.read_bytes(), trusted)
    except (OSError, FormatError) as error:
        print(sanitize(f"docseal_verify: {error}"), file=sys.stderr)
        return 3
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=True))
    else:
        print(report["overall"].upper())
        for axis, verdict in report["axes"].items():
            print(f"  {axis:<13} {verdict}")
        for item in report["issues"]:
            print(sanitize(f"  [{item['axis']}] {item.get('subject', '')} {item['message']}".rstrip()))
    return {"valid": 0, "invalid": 1, "indeterminate": 2}[report["overall"]]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
