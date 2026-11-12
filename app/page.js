import { q, q1, reglage } from '../lib/db';
import { LIBELLES } from '../lib/regles';
import { TRANSPORTEURS } from '../lib/transporteurs';
export const dynamic = 'force-dynamic';

const lib = (c) => LIBELLES[c] || c || '—';
const quand = (d) => d ? new Date(d).toLocaleString('fr-FR', { timeZone: 'Africa/Tunis', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
function Action({ action, valeur, id, children, cls }) {
  return (
    <form className="en-ligne" method="post" action="/api/admin">
      <input type="hidden" name="action" value={action} />
      {valeur != null && <input type="hidden" name="valeur" value={valeur} />}
      {id != null && <input type="hidden" name="id" value={id} />}
      <button className={cls} type="submit">{children}</button>
    </form>
  );
}

export default async function Tableau({ searchParams }) {
  let erreur = null;
  let d = {};
  try {
    const [mode, pause] = [await reglage('mode', 'simulation'), await reglage('pause', 'non')];
    d = {
      mode, pause,
      file: await q("SELECT * FROM file WHERE etat IN ('attente','simule') ORDER BY (cible <> 'Livraison-en-cours'), id LIMIT 100"),
      sortis: await q1("SELECT count(*) FILTER (WHERE etat = 'fait') fait, count(*) FILTER (WHERE etat = 'deja') deja, count(*) FILTER (WHERE etat IN ('ignore','annulee')) ignore, count(*) FILTER (WHERE etat IN ('refuse','erreur')) echec FROM file WHERE traite_le > now() - interval '1 hour'"),
      nFile: (await q1("SELECT count(*) FILTER (WHERE etat='attente') a, count(*) FILTER (WHERE etat='simule') s FROM file")),
      heure: Number((await q1("SELECT count(*) n FROM journal WHERE mode='reel' AND ok AND date > now() - interval '1 hour'")).n),
      jour: Number((await q1("SELECT count(*) n FROM journal WHERE mode='reel' AND ok AND date > date_trunc('day', now() AT TIME ZONE 'Africa/Tunis') AT TIME ZONE 'Africa/Tunis'")).n),
      alertes: await q('SELECT * FROM alertes WHERE NOT vue ORDER BY id DESC LIMIT 150'),
      nAlertes: Number((await q1('SELECT count(*) n FROM alertes WHERE NOT vue')).n),
      journal: await q('SELECT * FROM journal ORDER BY id DESC LIMIT 100'),
      colis: await q('SELECT transporteur, count(*) FILTER (WHERE NOT fini) suivis, count(*) total, max(maj_le) maj FROM colis GROUP BY transporteur ORDER BY transporteur'),
      passages: await q("SELECT DISTINCT ON (type) type, date, resume FROM passages ORDER BY type, date DESC"),
      bo: await q1('SELECT count(*) n, max(lu_le) lu FROM commandes_bo'),
      aEvaluer: Number((await q1('SELECT count(*) n FROM a_evaluer')).n),
      rattrapage: await reglage('rattrapage_jusqua', ''),
      aRelire: Number((await q1('SELECT count(*) n FROM colis WHERE NOT fini AND suivi_le IS NULL')).n),
    };
  } catch (e) { erreur = e.message; }
  const msg = searchParams?.msg;
  if (erreur) return <main><div className="carte"><h1>Synchro statuts Drest</h1><p className="ko">Erreur : {erreur}</p></div></main>;
  const reel = d.mode === 'reel';
  const rattrapage = d.rattrapage && new Date(d.rattrapage) > new Date() ? new Date(d.rattrapage) : null;
  const minutesFile = Math.ceil(Number(d.nFile.a) / ((Number(process.env.LIMITE_PAR_HEURE) || 700) / 60));
  return (
    <main>
      <div className="entete">
        <div>
          <h1>Synchro statuts Drest</h1>
          <span className="doux">Change uniquement le statut des commandes (« Forcer un statut »), au plus {process.env.LIMITE_PAR_HEURE || 700} par heure.</span>
        </div>
        <div className="actions">
          <span className={`badge ${reel ? 'reel' : 'sim'}`}>{reel ? 'RÉEL' : 'SIMULATION'}</span>
          {d.pause === 'oui' && <span className="badge pause">EN PAUSE</span>}
          {reel ? <Action action="mode" valeur="simulation">Repasser en simulation</Action>
                : <Action action="mode" valeur="reel" cls="principal">Passer en réel</Action>}
          {d.pause === 'oui' ? <Action action="pause" valeur="non">Reprendre</Action> : <Action action="pause" valeur="oui" cls="danger">Pause</Action>}
        </div>
      </div>
      <form method="get" action="/commande" className="carte actions">
        <input name="n" placeholder="Rechercher une commande : DR-261110-92555" style={{ flex: 1, minWidth: 220, padding: 8, border: '1px solid var(--bord)', borderRadius: 8 }} />
        <button type="submit">Rechercher</button>
      </form>
      {msg && <div className="msg">{msg}</div>}
      {rattrapage && (
        <div className="msg">
          <b>Rattrapage en cours jusqu'à {quand(rattrapage)}</b> — collecte complète chaque minute.
          Colis à relire : <b>{d.aRelire}</b> · commandes à évaluer : <b>{d.aEvaluer}</b> · changements en file : <b>{d.nFile.a}</b>
          {reel ? ` (≈ ${minutesFile} min d'envoi au rythme protégé)` : ' (mode simulation : rien n\'est envoyé au BO)'}.{' '}
          <Action action="rattrapage_stop">Arrêter le rattrapage</Action>
        </div>
      )}

      <div className="grille">
        <div className="chiffre"><b>{d.nFile.a}</b><span>changements en attente</span></div>
        <div className="chiffre"><b>{d.nFile.s}</b><span>changements simulés</span></div>
        <div className="chiffre"><b>{d.heure}</b><span>faits dans l'heure</span></div>
        <div className="chiffre"><b>{d.jour}</b><span>faits aujourd'hui</span></div>
        <div className="chiffre"><b>{d.nAlertes}</b><span>alertes à voir</span></div>
        <div className="chiffre"><b>{d.bo?.n || 0}</b><span>commandes BO suivies (lu {quand(d.bo?.lu)})</span></div>
      </div>

      <div className="carte">
        <h2>Transporteurs</h2>
        <table><thead><tr><th>Transporteur</th><th>Accès</th><th>Colis en cours de suivi</th><th>Colis connus</th><th>Dernier changement</th></tr></thead>
          <tbody>{['Big Boss', 'AFEX', 'Aramex', 'Drest Delivery'].map((t) => {
            const c = d.colis.find((x) => x.transporteur === t) || {};
            const actif = TRANSPORTEURS[t] ? TRANSPORTEURS[t].actif() : null;
            return <tr key={t}><td>{t}</td><td>{actif == null ? <span className="doux">export seulement</span> : actif ? <span className="ok">configuré</span> : <span className="ko">accès manquants</span>}</td>
              <td>{c.suivis || 0}</td><td>{c.total || 0}</td><td>{quand(c.maj)}</td></tr>;
          })}</tbody></table>
        <p className="doux">Derniers passages : {d.passages.map((p) => `${p.type} ${quand(p.date)}`).join(' · ') || 'aucun'} — commandes à évaluer : <b>{d.aEvaluer}</b></p>
        <p className="doux">Sortis de la file dans l'heure : <b>{d.sortis.fait}</b> changés · {d.sortis.deja} déjà au bon statut · {d.sortis.ignore} ignorés (statut avancé ou annulée) · {d.sortis.echec} refusés / erreurs. Ordre d'envoi : d'abord les commandes qui passent en Livraison en cours (non traitées, validées…), puis Livrée et Retour.</p>
        <div className="actions">
          <Action action="collecte">Synchroniser maintenant</Action>
          {!rattrapage && <Action action="rattrapage" valeur="30" cls="principal">Tout synchroniser (rattrapage 30 min)</Action>}
          <Action action="envoi">Envoyer la file maintenant</Action>
        </div>
      </div>

      <div className="carte">
        <h2>Déposer des exports transporteurs</h2>
        <p className="doux">Rapport Aramex (TotalShipmentReport), export AFEX (Colis_transport), export Big Boss (colis_export) ou Drest Delivery (.csv) :
          l'application apprend les codes des colis, puis les suit seule toutes les 30 min.</p>
        <form method="post" action="/api/import" encType="multipart/form-data" className="actions">
          <input type="file" name="fichiers" multiple accept=".xlsx,.xls,.csv" style={{ maxWidth: 420, margin: 0 }} />
          <button className="principal" type="submit">Importer</button>
        </form>
      </div>

      <div className="carte">
        <h2>File d'attente ({d.nFile.a} en attente, {d.nFile.s} simulés)</h2>
        <p className="doux">« Appliquer cette commande » change tout de suite cette seule commande dans le BO (même en simulation) : pratique pour tester.</p>
        <table><thead><tr><th>Commande</th><th>Statut BO</th><th>→ Nouveau</th><th>Selon</th><th>Ajouté</th><th></th></tr></thead>
          <tbody>{d.file.map((f) => <tr key={f.id}><td><a href={`/commande?n=${f.commande}`}>{f.commande}</a></td><td>{lib(f.attendu)}</td><td><b>{lib(f.cible)}</b>{f.preciser && <span className="doux"> (correction)</span>}</td>
            <td>{f.transporteur} {f.colis} <span className="doux">{f.statut_transporteur}</span></td><td>{quand(f.cree_le)}</td>
            <td><Action action="tester" id={f.id}>Appliquer cette commande</Action> <Action action="retirer" id={f.id}>Retirer</Action></td></tr>)}</tbody></table>
      </div>

      <div className="carte">
        <div className="entete" style={{ marginBottom: 8 }}><h2>Alertes ({d.nAlertes})</h2>{d.nAlertes > 0 && <Action action="alertes_toutes_vues">Tout marquer vu</Action>}</div>
        <table><thead><tr><th>Date</th><th>Commande</th><th>Type</th><th>Détail</th><th></th></tr></thead>
          <tbody>{d.alertes.map((a) => <tr key={a.id}><td>{quand(a.date)}</td><td>{a.commande && a.commande !== '—' ? <a href={`/commande?n=${a.commande}`}>{a.commande}</a> : a.commande}</td><td>{a.type}</td><td>{a.detail}</td><td><Action action="alerte_vue" id={a.id}>Vu</Action></td></tr>)}</tbody></table>
      </div>

      <div className="carte">
        <h2>Journal (100 derniers)</h2>
        <table><thead><tr><th>Date</th><th>Mode</th><th>Commande</th><th>Avant → Après</th><th>Selon</th><th>Résultat</th><th></th></tr></thead>
          <tbody>{d.journal.map((j) => <tr key={j.id}><td>{quand(j.date)}</td><td>{j.mode === 'reel' ? 'réel' : <span className="doux">simulation</span>}</td><td><a href={`/commande?n=${j.commande}`}>{j.commande}</a></td>
            <td>{lib(j.avant)} → <b>{lib(j.apres)}</b></td><td>{j.transporteur} {j.colis}</td>
            <td className={j.ok ? 'ok' : 'ko'}>{j.ok ? '✓' : '✗'} <span className="doux">{j.resultat}</span></td>
            <td>{j.mode === 'reel' && j.ok && !j.annule && <Action action="annuler" id={j.id}>Annuler</Action>}{j.annule && <span className="doux">annulé</span>}</td></tr>)}</tbody></table>
      </div>
    </main>
  );
}
