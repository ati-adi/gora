// WP1 — nightly backup (01 §11.7): gora.db + keys.db copies in config.backupDir, 7-day retention, and the crypto-shred
// reaching backups (a DEK destroyed before a backup is absent from it).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openKeyStore } from '../../../src/db/keystore.ts';
import { backupStamp, parseBackupStamp, pruneBackups, runBackup, createPrivacyService } from '../../../src/privacy/index.ts';
import { KEK } from '../db/env.ts';
import { privEnv, seedUser, type PrivEnv } from './env.ts';

let p: PrivEnv;
afterEach(() => p?.dispose());
const D = 86_400_000;

describe('backup (01 §11.7)', () => {
  it('stamps round-trip', () => {
    const t = Date.UTC(2026, 8, 28, 3, 30, 5);
    expect(backupStamp(t)).toBe('20260928T033005Z');
    expect(parseBackupStamp(backupStamp(t))).toBe(t);
    expect(parseBackupStamp('nope')).toBeNull();
  });

  it('writes a consistent copy of gora.db and a separate copy of keys.db', async () => {
    p = privEnv();
    const { u, c } = seedUser(p);
    p.crypto.destroyDek(`e:${c.id}:1`);
    const r = await runBackup(p.s, p.clock.now());
    expect(r.goraPath).toBe(join(p.s.config.backupDir, 'gora', 'gora-20260928T090000Z.db'));
    expect(r.keysPath).toBe(join(p.s.config.backupDir, 'keys', 'keys-20260928T090000Z.db'));
    const g = new DatabaseSync(r.goraPath, { readOnly: true });
    expect((g.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(u.id) as { n: number }).n).toBe(1);
    expect((g.prepare(`SELECT name FROM sqlite_master WHERE name = 'deks'`).all() as unknown[]).length).toBe(0);
    g.close();
    const ks = openKeyStore(r.keysPath, KEK);
    expect(ks.isDestroyed(`e:${c.id}:1`)).toBe(true);
    expect(ks.get(`e:${c.id}:2`)).toBeInstanceOf(Uint8Array);
    ks.close();
    expect(readdirSync(join(p.s.config.backupDir, 'gora')).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('keeps 7 days: older copies (and stale .tmp files) are pruned, unrelated files are left alone', async () => {
    p = privEnv();
    seedUser(p);
    const first = await runBackup(p.s, p.clock.now());
    await p.clock.advance(3 * D);
    await runBackup(p.s, p.clock.now());
    const junk = join(p.s.config.backupDir, 'gora', 'README.txt');
    writeFileSync(junk, 'x');
    mkdirSync(join(p.s.config.backupDir, 'keys'), { recursive: true });
    const staleTmp = join(p.s.config.backupDir, 'keys', `keys-${backupStamp(p.clock.now() - 2 * 3_600_000)}.db.tmp`);
    writeFileSync(staleTmp, 'x');
    await p.clock.advance(5 * D);
    const r = await runBackup(p.s, p.clock.now());
    expect(r.pruned).toBe(3); // first gora + first keys + stale tmp
    expect(existsSync(first.goraPath)).toBe(false);
    expect(existsSync(first.keysPath)).toBe(false);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(junk)).toBe(true);
    expect(readdirSync(join(p.s.config.backupDir, 'keys')).filter((f) => f.endsWith('.db'))).toHaveLength(2);
    expect(pruneBackups(join(p.s.config.backupDir, 'missing'), p.clock.now())).toBe(0);
  });

  it('runs as the nightly backup job', async () => {
    p = privEnv();
    createPrivacyService(p.s);
    await p.clock.set(Date.UTC(2026, 8, 29, 3, 30));
    await p.scheduler.tick();
    const job = [...p.scheduler.jobs.values()].find((j) => j.kind === 'backup')!;
    expect(job.status).toBe('done');
    expect(readdirSync(join(p.s.config.backupDir, 'gora'))).toEqual(['gora-20260929T033000Z.db']);
  });
});
