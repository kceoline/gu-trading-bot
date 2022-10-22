import BN from 'bn.js';
import hashJs from 'hash.js';
import elliptic from 'elliptic';
import * as encUtils from 'enc-utils';
import prompt from 'prompt';
import crypto from 'crypto';
import { Wallet } from '@ethersproject/wallet';
import { SigningKey } from '@ethersproject/signing-key';
import { joinSignature, splitSignature } from '@ethersproject/bytes';
import { hashMessage } from '@ethersproject/hash';
import assert from 'assert';
import ethereumWallet from 'ethereumjs-wallet';
import { starkEc } from './stark.curve';
import { deserializeSignature, serializeEthSignature } from './crypto';
import fs from 'fs';

const DEFAULT_SIGNATURE_MESSAGE = 'Only sign this request if you’ve initiated an action with Immutable X.';

if (!fs.existsSync('./wallet.json')) {
  console.log('Please run "npm run wallet" to create wallet.json!');
  process.exit(0);
}

const { salt, iv, encPrivateKey }: Record<string, string> = JSON.parse(await fs.promises.readFile('./wallet.json', 'utf8'));

const schema: any = { properties: { password: { hidden: true }}};
const password: string = await new Promise((resolve) => {
  prompt.start();
  prompt.get(schema, (err: any, res: any) => {
    resolve(res.password);
  });
});

const key = crypto.scryptSync(password, salt, 32);
const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv, 'hex'));
const decrypted = Buffer.concat([decipher.update(Buffer.from(encPrivateKey, 'hex')), decipher.final()]);
const privateKey: string = decrypted.toString('hex');

class EthereumSigner extends Wallet {
  public async signMessage(msg: string): Promise<string> {
    const signature = deserializeSignature(await super.signMessage(msg));
    return serializeEthSignature(signature);
  }
}

class StandardStarkSigner {
  private keyPair: elliptic.ec.KeyPair;

  constructor(private privateKey: string, private address: string) {
    const accountPath = StandardStarkSigner.getAccountPath('starkex', 'immutablex', address, '1');
    const signingKey = new SigningKey(`0x${privateKey}`);
    const signatureKey = joinSignature(signingKey.signDigest(hashMessage(DEFAULT_SIGNATURE_MESSAGE)));
    this.keyPair = StandardStarkSigner.getKeyPairFromPath(splitSignature(signatureKey).s, accountPath);
  }

  public getAddress(): string {
    const xCoordinate = this.keyPair.getPublic().getX().toString('hex');
    return encUtils.sanitizeHex(xCoordinate);
  }

  public async signMessage(msg: string): Promise<string> {
    return StandardStarkSigner.serialize(this.keyPair.sign(StandardStarkSigner.fixMsgHashLen(msg)));
  }

  private static serialize(sig: elliptic.ec.Signature): string {
    return encUtils.addHexPrefix(
      encUtils.padLeft(sig.r.toString('hex'), 64) +
      encUtils.padLeft(sig.s.toString('hex'), 64),
    );
  }

  private static fixMsgHashLen(msg: string) {
    msg = encUtils.removeHexPrefix(msg);
    msg = new BN(msg, 'hex').toString('hex');

    if (msg.length <= 62) {
      return msg;
    }
    if (msg.length !== 63) {
      throw new Error('StarkCurveInvalidMessageLength');
    }

    return `${msg}0`;
  }

  private static getIntFromBits(hex: string, start: number, end?: number) {
    if (end === void 0) { end = undefined; }
    const bin = encUtils.hexToBinary(hex);
    const bits = bin.slice(start, end);

    return encUtils.binaryToNumber(bits);
  }

  private static getAccountPath(layer: string, application: string, ethereumAddress: string, index: string) {
    const layerHash = hashJs.sha256().update(layer).digest('hex');
    const applicationHash = hashJs.sha256().update(application).digest('hex');
    const layerInt = StandardStarkSigner.getIntFromBits(layerHash, -31);
    const applicationInt = StandardStarkSigner.getIntFromBits(applicationHash, -31);
    const ethAddressInt1 = StandardStarkSigner.getIntFromBits(ethereumAddress, -31);
    const ethAddressInt2 = StandardStarkSigner.getIntFromBits(ethereumAddress, -62, -31);

    return "m/2645'/" + layerInt + "'/" + applicationInt + "'/" + ethAddressInt1 + "'/" + ethAddressInt2 + "'/" + index;
  }

  private static isHexPrefixed(str: string) {
    return str.substring(0, 2) === '0x';
  }

  private static hashKeyWithIndex(key: string, index: number) {
    return new BN(hashJs
      .sha256()
      .update(encUtils.hexToBuffer(encUtils.removeHexPrefix(key) + encUtils.sanitizeBytes(encUtils.numberToHex(index), 2)))
      .digest('hex'), 16);
  }

  private static grindKey(privateKey: string) {
    const ORDER = new BN('08000000 00000010 ffffffff ffffffff b781126d cae7b232 1e66a241 adc64d2f', 16);
    const SECP_ORDER = new BN('FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFE BAAEDCE6 AF48A03B BFD25E8C D0364141', 16);
    var i = 0;
    var key = StandardStarkSigner.hashKeyWithIndex(privateKey, i);
    while (!key.lt(SECP_ORDER.sub(SECP_ORDER.mod(ORDER)))) {
      key = StandardStarkSigner.hashKeyWithIndex(key.toString(16), i);
      i = i++;
    }

    return key.mod(ORDER).toString('hex');
  }

  private static getKeyPairFromPath(seed: string, path: string) {
    assert(StandardStarkSigner.isHexPrefixed(seed), 'Hex strings expected to be prefixed with 0x.');
    var privateKey = (ethereumWallet as any).hdkey
      .fromMasterSeed(Buffer.from(seed.slice(2), 'hex')) // assuming seed is '0x...'
      .derivePath(path)
      .getWallet()
      .getPrivateKeyString();

    return starkEc.keyFromPrivate(StandardStarkSigner.grindKey(privateKey), 'hex');
  }
}

export const ethSigner = new EthereumSigner(privateKey);
export const starkSigner = new StandardStarkSigner(privateKey, await ethSigner.getAddress());
