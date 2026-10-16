/**
 * Explicit plugin registry. The application decides which suites, anchors, and trust
 * policy exist; a package can only name them, never bring or select code.
 */
import { DEFAULT_LIMITS, type ContainerLimits } from "./container.js";
import { signedBytes } from "./digests.js";
import { fromBase64url } from "./encoding.js";
import type { AnchorProvider, KeyProvider, SignatureSuite, TrustPolicy } from "./plugins.js";
import { sealPackage, type SealOptions, type SealResult } from "./seal.js";
import { verifyPackage, type VerificationReport } from "./verify.js";

export interface DocSealConfig {
  signatures: readonly SignatureSuite[];
  anchors?: readonly AnchorProvider[];
  trust?: TrustPolicy;
  limits?: Partial<ContainerLimits>;
}

export interface VerifyCallOptions {
  /** Overrides the configured trust policy for this call. */
  trust?: TrustPolicy;
}

export class DocSeal {
  readonly signatures: readonly SignatureSuite[];
  readonly anchors: readonly AnchorProvider[];
  readonly trust: TrustPolicy | undefined;
  readonly limits: Readonly<ContainerLimits>;

  constructor(config: DocSealConfig) {
    this.signatures = Object.freeze([...config.signatures]);
    this.anchors = Object.freeze([...(config.anchors ?? [])]);
    this.trust = config.trust;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...config.limits });
    rejectDuplicates(this.signatures.flatMap((s) => s.profiles.map((p) => `${s.id}/${p}`)), "signature suite profile");
    rejectDuplicates(this.anchors.map((a) => a.id), "anchor provider");
  }

  /**
   * Seals a package and verifies its own signature before returning, so a faulty
   * KeyProvider (wrong key, broken HSM response) fails here rather than at the recipient.
   */
  async seal(options: SealOptions): Promise<SealResult> {
    const suite = this.suiteFor(options.signer);
    const result = await sealPackage(options);
    const { protected: header, value } = result.envelope;
    const check = await suite.verify(header.signer, signedBytes(header), fromBase64url(value), header.profile);
    if (check !== "valid") {
      throw new Error(`The key provider produced a signature that does not verify (${check})`);
    }
    return result;
  }

  verify(zip: Uint8Array, options: VerifyCallOptions = {}): Promise<VerificationReport> {
    const trust = options.trust ?? this.trust;
    return verifyPackage(zip, {
      suites: this.signatures,
      limits: this.limits,
      ...(trust === undefined ? {} : { trust }),
    });
  }

  private suiteFor(signer: KeyProvider): SignatureSuite {
    const suite = this.signatures.find((s) => s.id === signer.suite && s.profiles.includes(signer.profile));
    if (!suite) {
      throw new Error(`No registered signature suite for ${signer.suite}/${signer.profile}`);
    }
    return suite;
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
