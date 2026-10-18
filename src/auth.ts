import crypto from "node:crypto";
import { AdminActionType, SignedAdminIntent } from "./types.js";

export class AdminAuthManager {
  private readonly adminPublicKey: string;
  private readonly chainId: number;
  private lastNonce: number = 0;

  constructor(adminPublicKey: string, chainId: number = 31337) {
    this.adminPublicKey = adminPublicKey;
    this.chainId = chainId;
  }

  public getExpectedDomain(): string {
    return `QMOOSA:DEX_AGGREGATOR:${this.chainId}`;
  }

  public static generateKeyPair(): { publicKey: string; privateKey: string } {
    return crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
  }

  public static canonicalize(obj: any): any {
    if (obj === null || typeof obj !== "object") {
      return typeof obj === "bigint" ? obj.toString() : obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(AdminAuthManager.canonicalize);
    }
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, any> = {};
    for (const key of sortedKeys) {
      result[key] = AdminAuthManager.canonicalize(obj[key]);
    }
    return result;
  }

  public static computeParamsHash(params: Record<string, any>): string {
    const canonical = JSON.stringify(AdminAuthManager.canonicalize(params));
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  public static computeChallenge(
    action: AdminActionType,
    paramsHash: string,
    nonce: number,
    deadline: number,
    domain: string
  ): string {
    return `ACTION:${action}|PARAMS:${paramsHash}|NONCE:${nonce}|DEADLINE:${deadline}|DOMAIN:${domain}`;
  }

  public static signAdminIntent(
    action: AdminActionType,
    params: Record<string, any>,
    nonce: number,
    deadline: number,
    domain: string,
    privateKeyPem: string
  ): SignedAdminIntent {
    const paramsHash = AdminAuthManager.computeParamsHash(params);
    const challenge = AdminAuthManager.computeChallenge(action, paramsHash, nonce, deadline, domain);
    const signature = crypto.sign(null, Buffer.from(challenge), privateKeyPem).toString("hex");

    return {
      action,
      params,
      nonce,
      deadline,
      domain,
      signature
    };
  }

  public verifyAndConsume(intent: SignedAdminIntent): void {
    const expectedDomain = this.getExpectedDomain();
    if (intent.domain !== expectedDomain) {
      throw new Error(`Domain mismatch: expected '${expectedDomain}', got '${intent.domain}'`);
    }

    const now = Math.floor(Date.now() / 1000);
    if (intent.deadline < now) {
      throw new Error(`Intent expired: deadline ${intent.deadline} < current ${now}`);
    }

    if (intent.nonce <= this.lastNonce) {
      throw new Error(`Nonce replay rejected: intent nonce ${intent.nonce} <= last consumed ${this.lastNonce}`);
    }

    const paramsHash = AdminAuthManager.computeParamsHash(intent.params);
    const challenge = AdminAuthManager.computeChallenge(
      intent.action,
      paramsHash,
      intent.nonce,
      intent.deadline,
      intent.domain
    );

    let isValid = false;
    try {
      isValid = crypto.verify(
        null,
        Buffer.from(challenge),
        this.adminPublicKey,
        Buffer.from(intent.signature, "hex")
      );
    } catch {
      isValid = false;
    }

    if (!isValid) {
      throw new Error(`Cryptographic verification failed for intent '${intent.action}'`);
    }

    this.lastNonce = intent.nonce;
  }
}
