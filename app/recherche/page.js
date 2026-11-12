import { q, q1 } from '../../lib/db';
import { LIBELLES } from '../../lib/regles';
import { requete, ORIGINES, TRANSPORTEURS_LISTE } from '../../lib/filtres';
export const dynamic = 'force-dynamic';

// Recherche filtrée : changements faits (journal) ou file d'attente, par transporteur, origine, date / heure, statut avant / après.
const lib = (c) => LIBELLES[c] || c || '—';
const quand = (d) => d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Tunis', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const STATUTS = [['Untreated', 'Non traitée (Untreated)'], ['Valid', 'Validée'], ['Confirmed', 'Confirmée'], ['Inprogress', 'En préparation'],
  ['attente_enlevement', 'Attente enlèvement'], ['DEPOSIT', 'Dépôt'], ['Collected', 'Collectée'], ['COLLECTED_BY_COURIER', 'Collectée par coursier'],
  ['PrintQR', 'QR imprimé'], ['SCANNED', 'Scannée'], ['SCANNED_BY_DREST', 'Scannée Drest'],
  ['Livraison-en-cours', 'Livraison en cours'], ['Delevred', 'Livrée'], ['retour-expediteur', 'Retour expéditeur']];
const ETATS = { attente: 'en attente', simule: 'simulé', fait: 'fait ✓', deja: 'déjà bon', ignore: 'ignoré', refuse: 'refusé', annulee: 'annulée', erreur: 'erreur', retire: 'retiré' };
const champ = { padding: 7, border: '1px solid var(--bord)', borderRadius: 8, minWidth: 0 };

function Choix({ name, valeur, options, tous = 'Tous' }) {
  return <select name={name} defaultValue={valeur || ''} style={champ}><option value="">{tous}</option>
    {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
}

export default async function Recherche({ searchParams: p = {} }) {
  const { vue, sql, total, valeurs } = requete(p);
  let lignes = [], n = 0, erreur = null;
  try { lignes = await q(sql, valeurs); n = Number((await q1(total, valeurs)).n); } catch (e) { erreur = e.message; }
  const qs = new URLSearchParams(Object.entries(p).filter(([, x]) => x)).toString();
  return (
    <main>
      <div className="entete"><div><h1>Recherche filtrée</h1><span className="doux"><a href="/">← retour au tableau de bord</a></span></div></div>
      <form method="get" action="/recherche" className="carte">
        <div className="grille" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <label>Voir<br /><Choix name="vue" valeur={vue} tous="Changements faits (journal)" options={[['file', "File d'attente"]]} /></label>
          <label>N° de commande<br /><input name="n" defaultValue={p.n || ''} placeholder="DR-2611…" style={champ} /></label>
          <label>Société de livraison<br /><Choix name="transporteur" valeur={p.transporteur} options={TRANSPORTEURS_LISTE.map((t) => [t, t])} /></label>
          <label>Origine du colis<br /><Choix name="origine" valeur={p.origine} options={Object.entries(ORIGINES)} /></label>
          <label>Du (date et heure)<br /><input type="datetime-local" name="du" defaultValue={p.du || ''} style={champ} /></label>
          <label>Au (date et heure)<br /><input type="datetime-local" name="au" defaultValue={p.au || ''} style={champ} /></label>
          <label>Statut avant<br /><Choix name="avant" valeur={p.avant} options={STATUTS} /></label>
          <label>Statut après<br /><Choix name="apres" valeur={p.apres} options={STATUTS} /></label>
          {vue === 'journal'
            ? <label>Résultat<br /><Choix name="resultat" valeur={p.resultat} options={[['ok', 'Réussi'], ['ko', 'Échoué'], ['annule', 'Annulé']]} /></label>
            : <label>État dans la file<br /><Choix name="etat" valeur={p.etat} options={Object.entries(ETATS)} /></label>}
          {vue === 'journal' && <label>Mode<br /><Choix name="mode" valeur={p.mode} options={[['reel', 'Réel'], ['simulation', 'Simulation']]} /></label>}
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="principal" type="submit">Filtrer</button>
          <a href="/recherche">Effacer les filtres</a>
          <a href={`/api/export?${qs}`}>Télécharger en CSV (Excel)</a>
        </div>
        <p className="doux">Heures de Tunis. Origine : comment l'application a connu le colis (fichier déposé, colis créé dans le BO, webhook, API).</p>
      </form>
      {erreur && <div className="carte ko">Erreur : {erreur}</div>}
      <div className="carte">
        <h2>{n} résultat(s){n > lignes.length ? ` — ${lignes.length} affichés (le CSV contient tout)` : ''}</h2>
        {vue === 'journal' ? (
          <table><thead><tr><th>Date</th><th>Commande</th><th>Avant → Après</th><th>Société</th><th>Colis</th><th>Origine</th><th>Mode</th><th>Résultat</th></tr></thead>
            <tbody>{lignes.map((j) => <tr key={j.id}><td>{quand(j.date)}</td><td><a href={`/commande?n=${j.commande}`}>{j.commande}</a></td>
              <td>{lib(j.avant)} → <b>{lib(j.apres)}</b></td><td>{j.transporteur}</td><td>{j.colis}</td><td>{ORIGINES[j.origine] || '—'}</td>
              <td>{j.mode === 'reel' ? 'réel' : 'simulation'}</td><td className={j.ok ? 'ok' : 'ko'}>{j.annule ? 'annulé' : j.ok ? '✓' : '✗'} <span className="doux">{j.resultat}</span></td></tr>)}</tbody></table>
        ) : (
          <table><thead><tr><th>Ajouté</th><th>Traité</th><th>Commande</th><th>Statut BO → Nouveau</th><th>Société</th><th>Colis</th><th>Origine</th><th>État</th></tr></thead>
            <tbody>{lignes.map((f) => <tr key={f.id}><td>{quand(f.cree_le)}</td><td>{quand(f.traite_le)}</td><td><a href={`/commande?n=${f.commande}`}>{f.commande}</a></td>
              <td>{lib(f.attendu)} → <b>{lib(f.cible)}</b></td><td>{f.transporteur}</td><td>{f.colis} <span className="doux">{f.statut_transporteur}</span></td>
              <td>{ORIGINES[f.origine] || '—'}</td><td>{ETATS[f.etat] || f.etat} <span className="doux">{f.resultat}</span></td></tr>)}</tbody></table>
        )}
      </div>
    </main>
  );
}
