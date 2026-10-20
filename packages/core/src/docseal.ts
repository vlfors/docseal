/**
 * Explicit plugin registry. The application decides which suites, anchors, and trust
 * policy exist; a package can only name them, never bring or select code.
 */
import { checkSha256, type Sha256Factory } from "./bytes.js";
import { DEFAULT_LIMITS, type ContainerLimits } from "./container.js";
import { signedBytes } from "./digests.js";
import { fromBase64url } from "./encoding.js";
import type { AnchorProvider, ChainReader, KeyProvider, SignatureSuite, TrustPolicy } from "./plugins.js";
import type { ByteSink, ByteSource } from "./io.js";
import type { AnchorFile } from "./model.js";
import { sealPackage, sealPackageTo, type SealInfo, type SealOptions, type SealResult } from "./seal.js";
import { upgradePackage, upgradePackageTo, type UpgradeResult } from "./upgrade.js";
import { verifyPackage, type VerificationReport } from "./verify.js";

export interface DocSealConfig {
  signatures: readonly SignatureSuite[];
  anchors?: readonly AnchorProvider[];
  trust?: TrustPolicy;
  /** Public-chain data source used to check anchors. */
  chain?: ChainReader;
  limits?: Partial<ContainerLimits>;
  /** SHA-256 for documents, e.g. a native one; checked against a test vector on construction. */
  sha256?: Sha256Factory;
}

export interface VerifyCallOptions {
  /** Overrides the configured trust policy for this call. */
  trust?: TrustPolicy;
  /** Overrides the configured chain source for this call. */
  chain?: ChainReader;
}

export interface DocSealSealOptions extends Omit<SealOptions, "anchors"> {
  /** Submit the seal to the registered anchor providers. Defaults to true. */
  anchor?: boolean;
}

export class DocSeal {
  readonly signatures: readonly SignatureSuite[];
  readonly anchors: readonly AnchorProvider[];
  readonly trust: TrustPolicy | undefined;
  readonly chain: ChainReader | undefined;
  readonly limits: Readonly<ContainerLimits>;
  readonly sha256: Sha256Factory | undefined;

  constructor(config: DocSealConfig) {
    this.signatures = Object.freeze([...config.signatures]);
    this.anchors = Object.freeze([...(config.anchors ?? [])]);
    this.trust = config.trust;
    this.chain = config.chain;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...config.limits });
    if (config.sha256) {
      checkSha256(config.sha256);
    }
    this.sha256 = config.sha256;
    rejectDuplicates(this.signatures.flatMap((s) => s.profiles.map((p) => `${s.id}/${p}`)), "signature suite profile");
    rejectDuplicates(this.anchors.map((a) => a.id), "anchor provider");
  }

  /**
   * Seals a package and verifies its own signature before returning, so a faulty
   * KeyProvider (wrong key, broken HSM response) fails here rather than at the recipient.
   */
  async seal(options: DocSealSealOptions): Promise<SealResult> {
    const suite = this.suiteFor(options.signer);
    const { anchor = true, ...rest } = options;
    const result = await sealPackage({ ...rest, anchors: anchor ? this.anchors : [], ...this.hashing() });
    await checkOwnSignature(suite, result);
    return result;
  }

  /** Like {@link seal}, but streams the container to `output` instead of returning it. */
  async sealTo(output: ByteSink, options: DocSealSealOptions): Promise<SealInfo> {
    const suite = this.suiteFor(options.signer);
    const { anchor = true, ...rest } = options;
    const result = await sealPackageTo(output, { ...rest, anchors: anchor ? this.anchors : [], ...this.hashing() });
    await checkOwnSignature(suite, result);
    return result;
  }

  /** Verifies a package held in memory or read from a source, such as a file, piece by piece. */
  verify(input: Uint8Array | ByteSource, options: VerifyCallOptions = {}): Promise<VerificationReport> {
    const trust = options.trust ?? this.trust;
    const chain = options.chain ?? this.chain;
    return verifyPackage(input, {
      suites: this.signatures,
      anchors: this.anchors,
      limits: this.limits,
      ...this.hashing(),
      ...(trust === undefined ? {} : { trust }),
      ...(chain === undefined ? {} : { chain }),
    });
  }

  /** Completes pending anchor receipts. See {@link upgradePackage}. */
  upgrade(zip: Uint8Array): Promise<UpgradeResult> {
    return upgradePackage(zip, this.anchors, this.limits);
  }

  /** Streaming form of {@link upgrade}. See {@link upgradePackageTo}. */
  upgradeTo(
    input: ByteSource,
    output: (changed: boolean) => ByteSink | undefined | Promise<ByteSink | undefined>,
  ): Promise<{ changed: boolean; anchors: AnchorFile[] }> {
    return upgradePackageTo(input, output, this.anchors, this.limits);
  }

  private hashing(): { sha256?: Sha256Factory } {
    return this.sha256 ? { sha256: this.sha256 } : {};
  }

  private suiteFor(signer: KeyProvider): SignatureSuite {
    const suite = this.signatures.find((s) => s.id === signer.suite && s.profiles.includes(signer.profile));
    if (!suite) {
      throw new Error(`No registered signature suite for ${signer.suite}/${signer.profile}`);
    }
    return suite;
  }
}

/** A faulty KeyProvider (wrong key, broken HSM response) fails here rather than at the recipient. */
async function checkOwnSignature(suite: SignatureSuite, result: SealInfo): Promise<void> {
  const { protected: header, value } = result.envelope;
  const check = await suite.verify(header.signer, signedBytes(header), fromBase64url(value), header.profile);
  if (check !== "valid") {
    throw new Error(`The key provider produced a signature that does not verify (${check})`);
  }
}

function rejectDuplicates(ids: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${kind}: ${id}`);
    }
    seen.add(id);
  }
}
