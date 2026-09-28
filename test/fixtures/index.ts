// test/fixtures/index.ts (WP0) — typed access to shared fixtures.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TaintSource } from '../../src/contracts/common.ts';

const DIR = fileURLToPath(new URL('./', import.meta.url));

export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(DIR + rel));
}
export function fixtureText(rel: string): string {
  return readFileSync(DIR + rel, 'utf8');
}

export interface RedTeamFixture { id: string; source: TaintSource | 'guest_reply' | 'business_peer'; label: string; text: string; attackerTarget: string; expect: string }
/** 01 §11.3: one or more injections per wrapped untrusted source (email, web, calendar, business_peer, forward, group_member, guest_reply, file, import). */
export function redTeam(): RedTeamFixture[] {
  return JSON.parse(fixtureText('redteam/injections.json')) as RedTeamFixture[];
}

export const MEDIA = {
  /** 1×1 PNG */
  pixelPng: () => fixtureBytes('media/pixel.png'),
  /** one-page PDF, text "Hello Gora: invoice 231 USD" */
  helloPdf: () => fixtureBytes('media/hello.pdf'),
  transcript: () => fixtureText('media/transcript.txt').trim(),
};
