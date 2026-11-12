// Filtres communs à la page /recherche et à l'export CSV : changements faits (journal) ou file d'attente.
// Origine du colis = comment l'application l'a connu : fichier déposé (export / envoi en masse), BO (colis créé depuis le BO), webhook, API.
export const ORIGINES = { fichier: 'Fichier (export / masse)', bo: 'Colis créé dans le BO', webhook: 'Webhook Big Boss', api: 'API transporteur' };
export const TRANSPORTEURS_LISTE = ['Big Boss', 'Aramex', 'AFEX', 'Drest Delivery', 'annulation'];
const ORIGINE_SQL = `CASE WHEN k.source LIKE 'export%' THEN 'fichier' WHEN k.source = 'bo' THEN 'bo' WHEN k.source LIKE 'webhook%' THEN 'webhook' WHEN k.source IS NULL THEN NULL ELSE 'api' END`;

// Les heures saisies sont celles de Tunis (UTC+1)
const tunis = (v) => (v ? `${v}${v.length === 16 ? ':00' : ''}+01:00` : null);

export function requete(p, { csv = false } = {}) {
  const vue = p.vue === 'file' ? 'file' : 'journal';
  const w = [], v = [];
  const add = (sql, val) => { v.push(val); w.push(sql.replace('?', `$${v.length}`)); };
  const t = vue === 'journal' ? 'j' : 'f';
  const date = vue === 'journal' ? 'j.date' : 'coalesce(f.traite_le, f.cree_le)';
  if (p.n) add(`${t}.commande ILIKE ?`, `%${String(p.n).trim()}%`);
  if (p.transporteur) add(`${t}.transporteur = ?`, p.transporteur);
  if (p.origine) add(`${ORIGINE_SQL} = ?`, p.origine);
  if (p.du) add(`${date} >= ?::timestamptz`, tunis(p.du));
  if (p.au) add(`${date} <= ?::timestamptz`, tunis(p.au));
  if (p.avant) add(`${vue === 'journal' ? 'j.avant' : 'f.attendu'} = ?`, p.avant);
  if (p.apres) add(`${vue === 'journal' ? 'j.apres' : 'f.cible'} = ?`, p.apres);
  if (vue === 'journal') {
    if (p.mode) add('j.mode = ?', p.mode);
    if (p.resultat === 'ok') w.push('j.ok AND NOT j.annule'); else if (p.resultat === 'ko') w.push('NOT j.ok'); else if (p.resultat === 'annule') w.push('j.annule');
  } else if (p.etat) add('f.etat = ?', p.etat);
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const lim = csv ? 50000 : 300;
  const sql = vue === 'journal'
    ? `SELECT j.id, j.date, j.mode, j.commande, j.avant, j.apres, j.transporteur, j.colis, ${ORIGINE_SQL} AS origine, j.ok, j.annule, j.resultat, j.note
         FROM journal j LEFT JOIN colis k ON k.transporteur = j.transporteur AND k.code = j.colis AND k.commande = j.commande ${where} ORDER BY j.id DESC LIMIT ${lim}`
    : `SELECT f.id, f.cree_le, f.traite_le, f.commande, f.attendu, f.cible, f.transporteur, f.colis, ${ORIGINE_SQL} AS origine, f.statut_transporteur, f.etat, f.resultat
         FROM file f LEFT JOIN colis k ON k.transporteur = f.transporteur AND k.code = f.colis AND k.commande = f.commande ${where} ORDER BY f.id DESC LIMIT ${lim}`;
  const total = vue === 'journal'
    ? `SELECT count(*) n FROM journal j LEFT JOIN colis k ON k.transporteur = j.transporteur AND k.code = j.colis AND k.commande = j.commande ${where}`
    : `SELECT count(*) n FROM file f LEFT JOIN colis k ON k.transporteur = f.transporteur AND k.code = f.colis AND k.commande = f.commande ${where}`;
  return { vue, sql, total, valeurs: v };
}
