import { q, q1 } from '../../lib/db';
import { LIBELLES, numeros } from '../../lib/regles';
export const dynamic = 'force-dynamic';

// Fiche d'une commande : tout ce que l'application sait et a fait pour elle (recherche par n° de commande).
const lib = (c) => LIBELLES[c] || c || '—';
const quand = (d) => d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Tunis', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const ETATS = { attente: 'en attente d\'envoi', simule: 'simulé', fait: 'fait ✓', deja: 'déjà au bon statut', ignore: 'ignoré', refuse: 'refusé par le BO', annulee: 'commande annulée', erreur: 'erreur', retire: 'retiré à la main' };

function Action({ action, id, n, children, cls }) {
  return (
    <form className="en-ligne" method="post" action="/api/admin">
      <input type="hidden" name="action" value={action} />
      {id != null && <input type="hidden" name="id" value={id} />}
      <input type="hidden" name={action === 'verifier' ? 'n' : 'retour'} value={n} />
      <button className={cls} type="submit">{children}</button>
    </form>
  );
}

export default async function Commande({ searchParams }) {
  const saisie = String(searchParams?.n || '').trim();
  const n = (numeros(saisie)[0] || saisie).toUpperCase();
  const msg = searchParams?.msg;
  let d = null, erreur = null;
  if (n) {
    try {
      d = {
        bo: await q1('SELECT * FROM commandes_bo WHERE numero = $1', [n]),
        colis: await q('SELECT * FROM colis WHERE commande = $1 ORDER BY date_creation NULLS LAST', [n]),
        file: await q('SELECT * FROM file WHERE commande = $1 ORDER BY id DESC LIMIT 30', [n]),
        journal: await q('SELECT * FROM journal WHERE commande = $1 ORDER BY id DESC LIMIT 30', [n]),
        alertes: await q('SELECT * FROM alertes WHERE commande = $1 ORDER BY id DESC LIMIT 30', [n]),
        evts: await q('SELECT * FROM evenements WHERE commande = $1 ORDER BY id DESC LIMIT 200', [n]),
      };
    } catch (e) { erreur = e.message; }
  }
  const attente = d?.file.find((f) => f.etat === 'attente' || f.etat === 'simule');
  return (
    <main>
      <div className="entete">
        <div><h1>Recherche d'une commande</h1><span className="doux"><a href="/">← retour au tableau de bord</a></span></div>
      </div>
      <form method="get" action="/commande" className="carte actions">
        <input name="n" defaultValue={saisie} placeholder="DR-261110-92555" style={{ flex: 1, minWidth: 220, padding: 8, border: '1px solid var(--bord)', borderRadius: 8 }} />
        <button className="principal" type="submit">Rechercher</button>
      </form>
      {msg && <div className="msg">{msg}</div>}
      {erreur && <div className="carte ko">Erreur : {erreur}</div>}
      {d && (
        <>
          <div className="carte">
            <div className="entete" style={{ marginBottom: 8 }}>
              <h2>{n}</h2>
              <Action action="verifier" n={n} cls="principal">Vérifier maintenant</Action>
            </div>
            {d.bo ? (
              <table><tbody>
                <tr><td>Statut dans le BO</td><td><b>{lib(d.bo.statut_code)}</b>{d.bo.annulee && <span className="ko"> — commande annulée</span>} <span className="doux">(lu le {quand(d.bo.lu_le)})</span></td></tr>
                <tr><td>Créée le</td><td>{quand(d.bo.cree_le)}</td></tr>
                <tr><td>Colis créé (selon le BO)</td><td>{quand(d.bo.colis_cree_le)}</td></tr>
                <tr><td>Colis cherchés dans le BO</td><td>{d.bo.colis_bo_vu_le ? `le ${quand(d.bo.colis_bo_vu_le)} : ${d.bo.colis_bo_trouves || 0} trouvé(s)` : 'pas encore'}</td></tr>
                <tr><td>En attente d'envoi</td><td>{attente ? <b>{lib(attente.attendu)} → {lib(attente.cible)} ({ETATS[attente.etat]})</b> : 'rien'}</td></tr>
              </tbody></table>
            ) : <p className="ko">Commande pas encore vue dans la liste du BO (elle le sera à la prochaine collecte, ou elle a plus de {process.env.JOURS_SUIVI || 45} jours).</p>}
            <p className="doux">« Vérifier maintenant » relit le statut dans le BO, cherche les colis créés dans le BO, relit leur statut chez le transporteur, puis décide. Rien n'est changé dans le BO : un changement éventuel passe par la file.</p>
          </div>

          <div className="carte">
            <h2>Colis connus ({d.colis.length})</h2>
            {d.colis.length ? (
              <table><thead><tr><th>Transporteur</th><th>N° de colis</th><th>Statut chez le transporteur</th><th>→ Statut visé</th><th>Appris par</th><th>Créé le</th><th>Dernière lecture</th><th>Suivi</th></tr></thead>
                <tbody>{d.colis.map((c) => <tr key={c.transporteur + c.code}><td>{c.transporteur}</td><td>{c.code}</td><td>{c.statut_brut}</td>
                  <td>{c.echange ? 'échange (ignoré)' : lib(c.cible)}</td><td>{c.source}</td><td>{quand(c.date_creation)}</td><td>{quand(c.suivi_le || c.maj_le)}</td>
                  <td>{c.fini ? 'terminé' : 'en cours'}</td></tr>)}</tbody></table>
            ) : <p className="doux">Aucun colis connu : colis pas encore créé, créé directement chez le transporteur (déposer l'export), ou chez Drest Delivery.</p>}
          </div>

          <div className="carte">
            <h2>Historique</h2>
            {d.evts.length ? (
              <table><thead><tr><th>Date</th><th>Événement</th><th>Détail</th></tr></thead>
                <tbody>{d.evts.map((e) => <tr key={e.id}><td>{quand(e.date)}</td><td>{e.type}</td><td>{e.detail}</td></tr>)}</tbody></table>
            ) : <p className="doux">Rien encore (l'historique démarre avec cette version de l'application).</p>}
          </div>

          <div className="carte">
            <h2>Changements de statut (journal)</h2>
            {d.journal.length ? (
              <table><thead><tr><th>Date</th><th>Mode</th><th>Avant → Après</th><th>Selon</th><th>Résultat</th><th></th></tr></thead>
                <tbody>{d.journal.map((j) => <tr key={j.id}><td>{quand(j.date)}</td><td>{j.mode === 'reel' ? 'réel' : 'simulation'}</td>
                  <td>{lib(j.avant)} → <b>{lib(j.apres)}</b></td><td>{j.transporteur} {j.colis}</td>
                  <td className={j.ok ? 'ok' : 'ko'}>{j.ok ? '✓' : '✗'} <span className="doux">{j.resultat}</span></td>
                  <td>{j.mode === 'reel' && j.ok && !j.annule && <Action action="annuler" id={j.id} n={n}>Annuler</Action>}{j.annule && <span className="doux">annulé</span>}</td></tr>)}</tbody></table>
            ) : <p className="doux">Aucun changement fait par l'application.</p>}
          </div>

          <div className="carte">
            <h2>File d'attente (passages de cette commande)</h2>
            {d.file.length ? (
              <table><thead><tr><th>Ajouté</th><th>Statut BO → Nouveau</th><th>Selon</th><th>État</th><th>Résultat</th><th></th></tr></thead>
                <tbody>{d.file.map((f) => <tr key={f.id}><td>{quand(f.cree_le)}</td><td>{lib(f.attendu)} → <b>{lib(f.cible)}</b></td>
                  <td>{f.transporteur} {f.colis} <span className="doux">{f.statut_transporteur}</span></td><td>{ETATS[f.etat] || f.etat}</td><td className="doux">{f.resultat}</td>
                  <td>{(f.etat === 'attente' || f.etat === 'simule') && <><Action action="tester" id={f.id} n={n}>Appliquer</Action> <Action action="retirer" id={f.id} n={n}>Retirer</Action></>}</td></tr>)}</tbody></table>
            ) : <p className="doux">Jamais passée dans la file.</p>}
          </div>

          {d.alertes.length > 0 && (
            <div className="carte">
              <h2>Alertes</h2>
              <table><thead><tr><th>Date</th><th>Type</th><th>Détail</th><th></th></tr></thead>
                <tbody>{d.alertes.map((a) => <tr key={a.id}><td>{quand(a.date)}</td><td>{a.type}</td><td>{a.detail}</td>
                  <td>{a.vue ? <span className="doux">vue</span> : <Action action="alerte_vue" id={a.id} n={n}>Vu</Action>}</td></tr>)}</tbody></table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
