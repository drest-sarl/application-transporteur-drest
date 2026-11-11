import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { appelCronAutorise } from '../../../../lib/session';
import { envoi } from '../../../../lib/moteur';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Appelée chaque minute par cron-job.org : applique au plus 11 changements de statut (700 / heure), espacés de ~5 s.
async function go(req) {
  if (!appelCronAutorise(req)) return NextResponse.json({ erreur: 'clé absente ou fausse' }, { status: 401 });
  // par défaut : réponse immédiate (cron-job.org n'attend que 30 s), le travail continue en arrière-plan jusqu'au bout (≤ 60 s).
  // ?attendre=1 : attend la fin et renvoie le bilan (test à la main).
  if (new URL(req.url).searchParams.get('attendre')) {
    try { return NextResponse.json(await envoi()); }
    catch (e) { return NextResponse.json({ erreur: e.message }, { status: 500 }); }
  }
  waitUntil(envoi().catch((e) => console.error('envoi', e)));
  return NextResponse.json({ lance: 'envoi', le: new Date().toISOString() });
}
export const GET = go; export const POST = go;
