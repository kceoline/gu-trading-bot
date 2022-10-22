import crypto from 'crypto';
import prompt from 'prompt';
import fs from 'fs';

if (fs.existsSync('./wallet.json')) {
  console.log('File wallet.json exists. Please remove it manually to continue!');
  process.exit(0);
}

const schema: any = {
  properties: {
    privateKey: {
      hidden: true,
      description: 'Enter private key of your wallet (ETH)',
    },
    password: {
      hidden: true,
      description: 'Enter password to encode your wallet',
    },
  }
};

const salt = crypto.randomBytes(256).toString('hex');
const iv = crypto.randomBytes(16).toString('hex');

const { password, privateKey }: Record<string, string> = await new Promise((resolve) => {
  prompt.message = '';
  prompt.delimiter = '\n';
  prompt.start();
  prompt.get(schema, (err: any, res: any) => {
    resolve(res);
  });
});

const key = crypto.scryptSync(password, salt, 32);
const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv, 'hex'));
const encPrivateKey = Buffer.concat([cipher.update(Buffer.from(privateKey, 'hex')), cipher.final()]).toString('hex');

await fs.promises.writeFile('./wallet.json', JSON.stringify({
  salt,
  iv,
  encPrivateKey,
}, null, 2));
