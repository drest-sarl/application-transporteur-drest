import { NextResponse } from 'next/server';
import { lireExport } from '../../../lib/imports';
import { enregistrerColis, evaluer, majCommandesBO } from '../../../lib/moteur';
import { passage } from '../../../lib/db';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Dépôt d'un export transporteur : apprend les codes de colis (et leur statut), puis décide pour les commandes concernées.
export async function POST(req) {
  try {
    const form = await req.formData();
    const res = [];
    for (const f of form.getAll('fichiers')) {
      if (!f || typeof f === 'string') continue;
      try {
        const { type, colis } = lireExport(Buffer.from(await f.arrayBuffer()), f.name);
        const r = await enregistrerColis(colis, `export ${type}`);
        res.push({ fichier: f.name, type, colis: colis.length, nouveaux_ou_changes: r.changes });
      } catch (e) { res.push({ fichier: f.name, erreur: e.message }); }
    }
    const commandes_bo = await majCommandesBO(Date.now() + 15_000).catch((e) => 'erreur : ' + e.message);
    const { liste, ...decisions } = await evaluer(Date.now() + 25_000, 3000);
    await passage('import', { fichiers: res, decisions }, 'bouton', liste);
    const resume = res.map((r) => r.erreur ? `${r.fichier} : ERREUR ${r.erreur}` : `${r.type} : ${r.colis} colis lus (${r.nouveaux_ou_changes} nouveaux ou changés)`).join(' · ')
      + ` — commandes évaluées : ${decisions.evaluees}, ajoutées à la file : ${decisions.enFile}, alertes : ${decisions.alertes}`
      + (decisions.evaluees >= 3000 ? ' — il en reste : cliquez « Synchroniser maintenant » pour continuer' : '');
    return retour(req, resume);
  } catch (e) { return retour(req, 'Import : erreur ' + e.message); }
}

function retour(req, message) {
  return NextResponse.redirect(new URL('/?msg=' + encodeURIComponent(message.slice(0, 600)), req.url), 303);
}
