// hand_in: hand work in against a work order with nothing installed but Node and git.
// It checks the order is genuine, that the commit descends from the order's base and
// changes only the order's territory, then writes the delivery (tick.delivery.v1,
// spec/SPEC.md) signed by the doer's own key, and the bundle that carries the commits.
// The key lives on this machine only: it is never printed, returned or written to `out`.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { documentText, git, inTerritory, nonEmpty, readOrder } from './handlers.mjs';
import { documentHash, verifyDocument } from './verify.js';

const LIMITS = [
  'The signature proves the holder of the carried key handed this in. It says what the doer states, not that the work is right.',
  'The carried key is the doer\'s only if the reader already holds that key_id from somewhere else.',
  'Minutes and agent are the doer\'s own word.',
];

const REF = 'refs/tick/delivery';

/** The doer's private key: made once in the key folder with mode 0o600, reused after. */
async function doerKey() {
  const home = resolve(nonEmpty(process.env.TICK_ID_HOME || join(homedir(), '.tick-id'), 'the key folder'));
  await mkdir(home, { recursive: true });
  const keyFile = nonEmpty(join(home, 'id.pem'), 'the key file');
  let pem;
  try {
    pem = await readFile(keyFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`the key file ${keyFile} cannot be read: ${error.code ?? error.message}`);
    const { privateKey } = generateKeyPairSync('ed25519');
    try {
      await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    } catch (again) {
      if (again.code !== 'EEXIST') throw new Error(`the key file ${keyFile} cannot be written: ${again.code ?? again.message}`);
    }
    pem = await readFile(keyFile);
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    throw new Error(`the key file ${keyFile} does not hold an Ed25519 private key in PKCS8 PEM`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`the key file ${keyFile} does not hold an Ed25519 key`);
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return { privateKey, spki, keyId: createHash('sha256').update(spki).digest('hex').slice(0, 16) };
}

function checkArguments(args) {
  const { agent, model, minutes } = args;
  if (typeof agent !== 'string' || agent.trim() === '') throw new Error('agent must be a non-empty string: say who is handing in');
  if (model !== undefined && model !== null && typeof model !== 'string') throw new Error('model must be a string');
  if (minutes !== undefined && minutes !== null && !(typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0)) {
    throw new Error('minutes must be a finite number of zero or more');
  }
  for (const name of ['repository', 'commit', 'out']) {
    if (typeof args[name] !== 'string' || args[name].trim() === '') throw new Error(`${name} must be a non-empty string`);
  }
}

/** Hands the commit in against the order: writes delivery.json and work.bundle into `out`. */
export async function handIn(args) {
  checkArguments(args);
  const { agent, model, minutes } = args;

  const order = await readOrder(args);
  if (!order.genuine) {
    throw new Error(`the order is not genuine, so nothing was handed in: ${order.reasons.join('; ')}`);
  }
  if (order.base === null) throw new Error('the order names no base commit, so nothing was handed in');
  const contentHash = JSON.parse(await documentText(args, 'order')).content_hash;

  const source = resolve(nonEmpty(args.repository, 'repository'));
  const info = await stat(source).catch(() => null);
  if (info === null || !info.isDirectory()) throw new Error(`repository ${JSON.stringify(args.repository)} is not a folder`);
  let commit;
  try {
    commit = (await git(['rev-parse', '--verify', '--end-of-options', `${args.commit}^{commit}`], source)).trim();
  } catch {
    throw new Error(`commit ${JSON.stringify(args.commit)} is not a commit of the repository ${source}`);
  }
  const base = order.base;
  try {
    await git(['cat-file', '-e', `${base}^{commit}`], source);
  } catch {
    throw new Error(`the order's base ${base} is not in the repository ${source}`);
  }
  try {
    await git(['merge-base', '--is-ancestor', base, commit], source);
  } catch {
    throw new Error(`the order's base ${base} is not an ancestor of commit ${commit}: the work must be built on the base`);
  }

  const changed = (await git(['diff', '--name-only', '--no-renames', '-z', `${base}..${commit}`], source))
    .split('\0')
    .filter((path) => path !== '');
  const outside = changed.filter((path) => !inTerritory(path, order.territory));
  if (outside.length > 0) {
    throw new Error(`the commit changes files outside the order's territory: ${outside.join(', ')}`);
  }

  const tree = (await git(['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`], source)).trim();
  const { privateKey, spki, keyId } = await doerKey();

  const body = {
    order_hash: contentHash,
    repository: order.repository,
    base,
    commit,
    tree,
    tries: [{ agent, model: model ?? null, minutes: minutes ?? null, cents: null, cost: 'unknown' }],
  };
  const deliveryId = randomUUID();
  const bodyHash = await documentHash(body);
  const signature = sign(null, Buffer.from(`tick-delivery:v1:${deliveryId}:${bodyHash}`, 'utf8'), privateKey).toString('base64');

  const out = resolve(nonEmpty(args.out, 'out'));
  const deliveryFile = nonEmpty(join(out, 'delivery.json'), 'the delivery file');
  const bundleFile = nonEmpty(join(out, 'work.bundle'), 'the bundle file');
  const text = `${JSON.stringify(
    {
      schema: 'tick.delivery.v1',
      alg: 'ed25519',
      issued_at: new Date().toISOString(),
      coordinator: `doer:${keyId}`,
      delivery_id: deliveryId,
      delivery: body,
      content_hash: bodyHash,
      key: spki.toString('base64'),
      key_id: keyId,
      signature,
      limits: LIMITS,
    },
    null,
    2,
  )}\n`;

  // The checks above are all done; from here on, what was written is removed if the hand-in fails.
  await mkdir(out, { recursive: true });
  try {
    await writeFile(deliveryFile, text);
    try {
      await git(['update-ref', REF, commit], source);
      await git(['bundle', 'create', bundleFile, `${base}..${REF}`], source);
    } finally {
      await git(['update-ref', '-d', REF], source).catch(() => {});
    }
    const verdict = await verifyDocument(await readFile(deliveryFile, 'utf8'));
    if (!verdict.valid || verdict.kind !== 'delivery') {
      throw new Error(`the delivery written does not verify: ${verdict.reasons.join('; ')}`);
    }
  } catch (error) {
    await rm(deliveryFile, { force: true });
    await rm(bundleFile, { force: true });
    throw error;
  }

  return {
    handed_in: true,
    delivery_id: deliveryId,
    key_id: keyId,
    commit,
    tree,
    folder: out,
    files: ['delivery.json', 'work.bundle'],
    limits: LIMITS,
  };
}
