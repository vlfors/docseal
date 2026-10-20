/**
 * Plugin interfaces. Implementations are registered explicitly by the application;
 * a package can never select or load code by name (ARCHITECTURE.md §Core boundary).
 */

/** Result of a purely mathematical signature check, before any trust decision. */
export type SignatureCheck = "valid" | "invalid" | "unsupported";

/** Verifies signatures of one algorithm family. Must be pure and run in browsers. */
export interface SignatureSuite {
  /** Value of `protected.suite`, e.g. `"ed25519"`. */
  readonly id: string;
  /** Values of `protected.profile` this suite can verify, e.g. `["docseal-ed25519-v1"]`. */
  readonly profiles: readonly string[];
  /** Checks `signature` over `signedBytes` for the key identified by `signer` (e.g. a `did:key`). */
  verify(signer: string, signedBytes: Uint8Array, signature: Uint8Array, profile: string): Promise<SignatureCheck>;
}

/** Signs without revealing to the core where the private key lives (file, HSM, KMS, token). */
export interface KeyProvider {
  readonly suite: string;
  readonly profile: string;
  /** Signer identifier written to `protected.signer`. */
  getSigner(): Promise<string>;
  sign(signedBytes: Uint8Array): Promise<Uint8Array>;
}

export interface TrustContext {
  /** Confirmed anchor time, if any. Claimed times are never passed here. */
  readonly attestedAt: Date | null;
}

export interface TrustResult {
  readonly verdict: "trusted" | "untrusted" | "unknown";
  readonly reason?: string;
}

/** Decides whether a mathematically valid signer is acceptable. Separate from signature math. */
export interface TrustPolicy {
  readonly id: string;
  evaluate(signer: string, context: TrustContext): Promise<TrustResult>;
}

/** Anchor receipt as stored in `anchors/seal-N.json`. Everything in `cached` is untrusted. */
export interface AnchorReceipt {
  provider: string;
  /** CAIP-2 network identifier, e.g. `bip122:000000000019d6689c085ae165831e93`. */
  network: string;
  digestAlgorithm: "sha-256";
  /** Anchored digest (the seal), lowercase hex. */
  digest: string;
  /** Provider-specific proof, base64url. */
  proof: string;
  cached?: {
    status?: "pending" | "confirmed";
    submittedAt?: string;
    blockHeight?: number;
  };
}

export interface AnchorResult {
  readonly verdict: "confirmed" | "pending" | "invalid" | "unsupported";
  /** Proven time from the block header or TSA. Present only when confirmed. */
  readonly attestedAt?: Date;
  readonly confirmations?: number;
  /**
   * Height of the block the proof was checked against (the earliest, if several), whenever one
   * was: with a confirmed result, and with a pending one that has too few confirmations.
   */
  readonly blockHeight?: number;
  /** Data source used, copied from `ChainReader.source`, so the report shows whom we trusted. */
  readonly source?: string;
  readonly reason?: string;
}

/** Creates, upgrades, and verifies proofs of existence for a digest. */
export interface AnchorProvider {
  /** Value of `receipt.provider`, e.g. `"opentimestamps"`. */
  readonly id: string;
  submit(digest: Uint8Array): Promise<AnchorReceipt>;
  upgrade?(receipt: AnchorReceipt): Promise<AnchorReceipt>;
  verify(receipt: AnchorReceipt, digest: Uint8Array, chain: ChainReader): Promise<AnchorResult>;
}

export interface BitcoinBlockHeader {
  readonly height: number;
  /** Merkle root as raw bytes in internal (little-endian) byte order. */
  readonly merkleRoot: Uint8Array;
  /** Block header time, seconds since the Unix epoch. */
  readonly time: number;
}

/** Isolates public-network reads so the verifier chooses whom to trust. */
export interface ChainReader {
  /** Human-readable description of the data source, shown in the report. */
  readonly source: string;
  bitcoinBlockHeader?(height: number): Promise<BitcoinBlockHeader>;
  bitcoinTipHeight?(): Promise<number>;
}
