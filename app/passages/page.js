import { q } from '../../lib/db';
import { LIBELLES } from '../../lib/regles';
export const dynamic = 'force-dynamic';

// Historique des passages : chaque synchronisation (automatique ou par bouton), ce qu'elle a fait et quelles commandes elle a touchées.
const lib = (c) => LIBELLES[c] || c || '—';
const quand = (d) => d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Tunis', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const TYPES = { collecte: 'Collecte (lecture BO + transporteurs, décisions)', evaluer: 'Décision', envoi: 'Envoi vers le BO', appliquer: 'Appliquer une commande',
  import: 'Import de fichier', rattrapage: 'Tout synchroniser (rattrapage)', 'vérifier': 'Vérifier une commande' };
const DECL = { auto: 'Automatique (cron)', bouton: 'Bouton', rattrapage: 'Rattrapage' };
const champ = { padding: 7, border: '1px solid var(--bord)', borderRadius: 8, width: '100%', boxSizing: 'border-box', marginTop: 4, background: 'var(--carte)' };

function resume(type, r) {
  let o; try { o = JSON.parse(r); } catch (e) { return r; }
  if (o.deja_en_cours) return 'ignoré : une collecte tournait déjà';
  if (type === 'collecte') {
    const t = o.transporteurs || {}; const d = o.decisions || {};
    return `${o.commandes_bo ?? 0} commandes BO lues · colis BO : ${o.colis_bo?.colis_nouveaux ?? 0} nouveaux · Drest Delivery : ${typeof o.drest_delivery === 'object' ? `${o.drest_delivery.colis} colis lus, ${o.drest_delivery.changes} changés` : (o.drest_delivery ?? '—')} · relus : ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(', ')} · ${d.evaluees ?? 0} évaluées, ${d.enFile ?? 0} mises en file, ${d.alertes ?? 0} alertes`;
  }
  if (type === 'evaluer') return `${o.evaluees ?? 0} évaluées, ${o.enFile ?? 0} mises en file, ${o.alertes ?? 0} alertes, reste ${o.reste ?? 0}`;
  if (type === 'envoi') return o.pause ? 'en pause' : o.mode === 'simulation' ? `simulation : ${o.simules} notés` : `${o.faits ?? 0} changés, ${o.deja ?? 0} déjà bons, ${o.ignores ?? 0} ignorés, ${(o.refuses ?? 0) + (o.erreurs ?? 0)} refusés/erreurs`;
  if (type === 'import') return `${(o.fichiers || []).map((f) => f.erreur ? `${f.fichier} : erreur` : `${f.type} ${f.colis} colis`).join(' · ')} · ${o.decisions?.enFile ?? 0} mises en file`;
  if (type === 'rattrapage') return `${o.colis} colis à relire, ${o.commandes} commandes à réévaluer`;
  return r;
}

export default async function Passages({ searchParams: p = {} }) {
  const w = [], v = [];
  if (p.type) { v.push(p.type); w.push(`type = $${v.length}`); }
  if (p.declencheur) { v.push(p.declencheur); w.push(`declencheur = $${v.length}`); }
  if (p.tous !== '1') w.push("(nb > 0 OR type NOT IN ('collecte', 'envoi', 'evaluer'))");
  const lignes = await q(`SELECT * FROM passages ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, v);
  return (
    <main>
      <div className="entete"><div><h1>Historique des synchronisations</h1><span className="doux"><a href="/">← retour au tableau de bord</a> · <a href="/recherche">recherche filtrée</a></span></div></div>
      <form method="get" action="/passages" className="carte">
        <div className="grille" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label>Type<br /><select name="type" defaultValue={p.type || ''} style={champ}><option value="">Tous</option>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Lancé par<br /><select name="declencheur" defaultValue={p.declencheur || ''} style={champ}><option value="">Tous</option>{Object.entries(DECL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Afficher<br /><select name="tous" defaultValue={p.tous || ''} style={champ}><option value="">Seulement ceux qui ont touché des commandes</option><option value="1">Tous les passages (même sans effet)</option></select></label>
        </div>
        <div className="actions" style={{ marginTop: 12 }}><button className="principal" type="submit">Filtrer</button><a href="/passages">Effacer</a></div>
        <p className="doux">« Synchroniser maintenant » = Collecte lancée par Bouton (elle lit et met en file, elle ne change rien dans le BO). Les changements dans le BO viennent des passages « Envoi » et « Appliquer une commande ». Gardé 30 jours.</p>
      </form>
      <div className="carte">
        <table><thead><tr><th>Date</th><th>Type</th><th>Lancé par</th><th>Résultat</th><th>Commandes touchées</th></tr></thead>
          <tbody>{lignes.map((l) => (
            <tr key={l.id}><td>{quand(l.date)}</td><td>{TYPES[l.type] || l.type}</td><td>{DECL[l.declencheur] || l.declencheur}</td><td>{resume(l.type, l.resume)}</td>
              <td>{l.nb > 0 ? (
                <details><summary>{l.nb} commande(s)</summary>
                  <table><tbody>{(l.commandes || []).map((c, i) => <tr key={i}><td><a href={`/commande?n=${c.commande}`}>{c.commande}</a></td>
                    <td>{lib(c.avant)} → <b>{lib(c.apres)}</b></td><td className="doux">{c.resultat || c.selon || ''}</td></tr>)}</tbody></table>
                </details>) : <span className="doux">—</span>}</td></tr>))}</tbody></table>
        {!lignes.length && <p className="doux">Aucun passage pour ces filtres.</p>}
      </div>
    </main>
  );
}
