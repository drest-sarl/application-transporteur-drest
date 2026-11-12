import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { appelCronAutorise } from '../../../../lib/session';
import { evaluer } from '../../../../lib/moteur';
import { passage } from '../../../../lib/db';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Appelée chaque minute par cron-job.org : décide pour les commandes dont un colis a changé et remplit la file. Ne modifie rien dans le BO.
async function evaluerTout() { const r = await evaluer(Date.now() + 50_000, 5000); await passage('evaluer', r); return r; }
async function go(req) {
  if (!appelCronAutorise(req)) return NextResponse.json({ erreur: 'clé absente ou fausse' }, { status: 401 });
  // par défaut : réponse immédiate (cron-job.org n'attend que 30 s), le travail continue en arrière-plan jusqu'au bout (≤ 60 s).
  // ?attendre=1 : attend la fin et renvoie le bilan (test à la main).
  if (new URL(req.url).searchParams.get('attendre')) {
    try { return NextResponse.json(await evaluerTout()); }
    catch (e) { return NextResponse.json({ erreur: e.message }, { status: 500 }); }
  }
  waitUntil(evaluerTout().catch((e) => console.error('evaluer', e)));
  return NextResponse.json({ lance: 'evaluer', le: new Date().toISOString() });
}
export const GET = go; export const POST = go;
