import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { appelCronAutorise } from '../../../../lib/session';
import { collecte } from '../../../../lib/moteur';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Appelée toutes les 30 min par cron-job.org : relit le BO et les transporteurs, décide, remplit la file. Ne modifie rien dans le BO.
async function go(req) {
  if (!appelCronAutorise(req)) return NextResponse.json({ erreur: 'clé absente ou fausse' }, { status: 401 });
  // par défaut : réponse immédiate (cron-job.org n'attend que 30 s), le travail continue en arrière-plan jusqu'au bout (≤ 60 s).
  // ?attendre=1 : attend la fin et renvoie le bilan (test à la main).
  if (new URL(req.url).searchParams.get('attendre')) {
    try { return NextResponse.json(await collecte()); }
    catch (e) { return NextResponse.json({ erreur: e.message }, { status: 500 }); }
  }
  waitUntil(collecte().catch((e) => console.error('collecte', e)));
  return NextResponse.json({ lance: 'collecte', le: new Date().toISOString() });
}
export const GET = go; export const POST = go;
