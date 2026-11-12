import { NextResponse } from 'next/server';
import { lireExport } from '../../../lib/imports';
import { enregistrerColis, evaluer, majCommandesBO } from '../../../lib/moteur';
import { passage, q } from '../../../lib/db';
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
        // colis sans statut (envoi en masse) : seulement s'ils sont nouveaux — un colis déjà suivi garde son vrai statut ;
        // ils sont relus chez le transporteur dès la prochaine collecte
        let liste = colis;
        const sansStatut = colis.filter((c) => c.nouveauSeulement);
        if (sansStatut.length) {
          const connus = new Set((await q('SELECT transporteur, code, commande FROM colis WHERE code = ANY($1::text[])', [[...new Set(sansStatut.map((c) => c.code))]]))
            .map((x) => `${x.transporteur}|${x.code}|${x.commande}`));
          liste = colis.filter((c) => !c.nouveauSeulement || !connus.has(`${c.transporteur}|${c.code}|${c.commande}`));
        }
        const r = await enregistrerColis(liste, `export ${type}`);
        if (sansStatut.length) await q("UPDATE colis SET suivi_le = NULL WHERE source = $1 AND code = ANY($2::text[]) AND statut_brut LIKE 'Colis créé%'", [`export ${type}`, sansStatut.map((c) => c.code)]);
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
