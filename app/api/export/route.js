import { q } from '../../../lib/db';
import { requete, ORIGINES } from '../../../lib/filtres';
import { LIBELLES } from '../../../lib/regles';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Export CSV (séparateur ;, UTF-8 avec BOM pour Excel) des résultats de /recherche — mêmes filtres.
const h = (d) => d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' }) : '';
const cel = (x) => { const s = String(x ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export async function GET(req) {
  const p = Object.fromEntries(new URL(req.url).searchParams);
  const { vue, sql, valeurs } = requete(p, { csv: true });
  const lignes = await q(sql, valeurs);
  const lib = (c) => LIBELLES[c] || c || '';
  const ent = vue === 'journal'
    ? ['Date', 'Commande', 'Statut avant', 'Statut après', 'Société', 'Colis', 'Origine', 'Mode', 'Réussi', 'Annulé', 'Réponse BO', 'Note']
    : ['Ajouté', 'Traité', 'Commande', 'Statut BO', 'Nouveau statut', 'Société', 'Colis', 'Statut transporteur', 'Origine', 'État', 'Résultat'];
  const rows = lignes.map((r) => vue === 'journal'
    ? [h(r.date), r.commande, lib(r.avant), lib(r.apres), r.transporteur, r.colis, ORIGINES[r.origine] || '', r.mode, r.ok ? 'oui' : 'non', r.annule ? 'oui' : 'non', r.resultat, r.note]
    : [h(r.cree_le), h(r.traite_le), r.commande, lib(r.attendu), lib(r.cible), r.transporteur, r.colis, r.statut_transporteur, ORIGINES[r.origine] || '', r.etat, r.resultat]);
  const csv = '﻿' + [ent, ...rows].map((l) => l.map(cel).join(';')).join('\r\n');
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="synchro-${vue}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv"` } });
}
