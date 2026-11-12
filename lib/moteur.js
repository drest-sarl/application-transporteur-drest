// Le moteur : apprendre les colis, relire leurs statuts, décider, mettre en file, appliquer (≤ 700 / heure).
import { q, q1, reglage, fixer, alerte, passage, evenement } from './db';
import { TRANSPORTEURS } from './transporteurs';
import { decider, AMONT, LIVRE, RETOUR, EN_COURS, LIBELLES } from './regles';
import { pageCommandes, lireCommande, forcerStatut, colisDuBO } from './bo';

const JOURS = Number(process.env.JOURS_SUIVI || 45);
const LIMITE_HEURE = Number(process.env.LIMITE_PAR_HEURE || 700);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const RELIRE_MIN = Number(process.env.RELIRE_MINUTES || 8); // un colis en cours est relu chez le transporteur au plus toutes les 8 min

// ---------- 1. enregistrer des colis (webhook, export déposé, relecture) ----------
export async function enregistrerColis(liste, source) {
  if (!liste.length) return { recus: 0, changes: 0 };
  let changes = 0;
  for (let i = 0; i < liste.length; i += 500) {
    const parCle = new Map();
    for (const c of liste.slice(i, i + 500)) {
      if (!c.commande) continue; // colis sans n° de commande : inutilisable
      parCle.set(`${c.transporteur}|${c.code}|${c.commande}`, { ...c, fini: [LIVRE, RETOUR].includes(c.cible) || c.cible === 'ignore' });
    }
    const lot = [...parCle.values()];
    if (!lot.length) continue;
    const r = await q(`
      INSERT INTO colis (transporteur, code, commande, statut_brut, cible, date_creation, date_statut, echange, fini, source, maj_le, suivi_le)
      SELECT x.transporteur, x.code, x.commande, x.statut_brut, x.cible, x.date_creation, x.date_statut, coalesce(x.echange, false), x.fini, $2, now(), now()
        FROM json_to_recordset($1::json) AS x(transporteur text, code text, commande text, statut_brut text, cible text,
             date_creation timestamptz, date_statut timestamptz, echange boolean, fini boolean)
      ON CONFLICT (transporteur, code, commande) DO UPDATE SET
        statut_brut = EXCLUDED.statut_brut, cible = EXCLUDED.cible,
        date_creation = coalesce(colis.date_creation, EXCLUDED.date_creation), date_statut = coalesce(EXCLUDED.date_statut, colis.date_statut),
        echange = colis.echange OR EXCLUDED.echange, fini = EXCLUDED.fini, maj_le = now(), suivi_le = now()
      WHERE colis.statut_brut IS DISTINCT FROM EXCLUDED.statut_brut
      RETURNING commande, transporteur, code, statut_brut, cible, (xmax = 0) AS nouveau`, [JSON.stringify(lot), source]);
    if (r.length) await q(`INSERT INTO evenements (commande, type, detail) SELECT x.commande, x.type, x.detail FROM json_to_recordset($1::json) AS x(commande text, type text, detail text)`,
      [JSON.stringify(r.map((x) => ({ commande: x.commande, type: x.nouveau ? 'colis appris' : 'colis changé',
        detail: `${x.transporteur} ${x.code} : ${x.statut_brut} → ${LIBELLES[x.cible] || x.cible} (source : ${source})` })))]);
    const cmds = [...new Set(r.map((x) => x.commande).filter(Boolean))];
    changes += r.length;
    if (cmds.length) await q('INSERT INTO a_evaluer (commande) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [cmds]);
  }
  return { recus: liste.length, changes };
}

// ---------- 2. copie des commandes du BO (id + statut), les plus récentes d'abord ----------
export async function majCommandesBO(finA) {
  // pages 1-2 à chaque passage (nouvelles commandes), puis on continue plus loin dans le passé tant qu'il reste du temps
  let curseur = Number(await reglage('bo_curseur', '3'));
  let lues = 0, p = 1;
  while (Date.now() < finA) {
    const { commandes, dernier } = await pageCommandes(p, 100);
    if (commandes.length) {
      await q(`INSERT INTO commandes_bo (numero, id, statut_code, statut, annulee, colis_cree_le, cree_le, lu_le)
        SELECT x.numero, x.id, x.statut_code, x.statut, x.annulee, x.colis_cree_le, x.cree_le, now()
          FROM json_to_recordset($1::json) AS x(numero text, id text, statut_code text, statut text, annulee boolean, colis_cree_le timestamptz, cree_le timestamptz)
        ON CONFLICT (numero) DO UPDATE SET id = EXCLUDED.id, statut_code = EXCLUDED.statut_code, statut = EXCLUDED.statut,
          annulee = EXCLUDED.annulee, colis_cree_le = EXCLUDED.colis_cree_le, lu_le = now()`,
      [JSON.stringify(commandes.map((c) => ({ numero: c.number || c.orderNumber, id: c.id, statut_code: c.statusCode, statut: c.status,
        annulee: !!(c.cancled || c.canceled), colis_cree_le: c.parcelCreatedAt || null, cree_le: c.dateCreation || c.placedAt || null })))]);
      lues += commandes.length;
    }
    const plusVieille = commandes.length ? (commandes[commandes.length - 1].dateCreation || commandes[commandes.length - 1].placedAt) : null;
    const fini = dernier || !commandes.length || (plusVieille && Date.now() - new Date(plusVieille) > JOURS * 864e5);
    if (p >= curseur) { curseur = fini ? 3 : p + 1; if (fini) await fixer('bo_complet', 'oui'); }
    if (fini && p >= 2) break;
    p = p < 2 ? p + 1 : Math.max(p + 1, curseur);
  }
  await fixer('bo_curseur', curseur);
  return lues;
}

// ---------- 2 bis. apprendre les n° de colis créés depuis le BO (Big Boss, Aramex, AFEX) ----------
// Commandes dont le BO indique un colis (parcelCreatedAt) et pas encore à un statut final : 3 routes /shipments/… par commande.
// Revue si un colis a été créé depuis la dernière lecture (réexpédition) ; si rien trouvé, réessai toutes les 2 h.
export async function decouvrirColisBO(finA) {
  const amont = [...AMONT];
  const bilan = { commandes: 0, colis_nouveaux: 0, erreurs: 0 };
  while (Date.now() < finA) {
    const lot = await q(`SELECT numero, id, colis_cree_le FROM commandes_bo
       WHERE NOT coalesce(annulee, false) AND statut_code = ANY($2::text[]) AND (
             -- le BO indique un colis : lu une fois (et de nouveau si un autre colis est créé), réessai 2 h pendant 3 jours si rien
             (colis_cree_le IS NOT NULL AND colis_cree_le > now() - ($1 || ' days')::interval
              AND (colis_bo_vu_le IS NULL OR colis_bo_vu_le < colis_cree_le
                   OR (coalesce(colis_bo_trouves, 0) = 0 AND colis_bo_vu_le < now() - interval '2 hours' AND colis_cree_le > now() - interval '3 days')))
             -- sécurité : commande validée de moins de 7 jours sans date de colis, sans colis connu : vérifiée toutes les 2 h
          OR (colis_cree_le IS NULL AND statut_code <> 'Untreated' AND cree_le > now() - interval '7 days' AND coalesce(colis_bo_trouves, 0) = 0
              AND (colis_bo_vu_le IS NULL OR colis_bo_vu_le < now() - interval '2 hours')
              AND NOT EXISTS (SELECT 1 FROM colis k WHERE k.commande = commandes_bo.numero)))
       ORDER BY (colis_cree_le IS NULL), colis_bo_vu_le NULLS FIRST, colis_cree_le DESC NULLS LAST LIMIT 4`, [JOURS, amont]);
    if (!lot.length) break;
    await Promise.all(lot.map(async (c) => {
      const r = await colisDuBO(c.id).catch((e) => ({ colis: [], erreurs: [e.message] }));
      if (r.erreurs.length) bilan.erreurs++;
      if (r.colis.length) {
        // nouveau colis : statut lu chez le transporteur au prochain passage (suivi_le vide) ; un colis déjà connu n'est pas modifié
        const ins = await q(`INSERT INTO colis (transporteur, code, commande, statut_brut, cible, date_creation, source, suivi_le)
            SELECT x.transporteur, x.code, $1, 'Colis créé dans le BO (' || coalesce(x.etat_bo, '') || ')', 'attente', x.date_creation, 'bo', NULL
              FROM json_to_recordset($2::json) AS x(transporteur text, code text, date_creation timestamptz, etat_bo text)
            ON CONFLICT (transporteur, code, commande) DO NOTHING RETURNING transporteur, code`, [c.numero, JSON.stringify(r.colis)]);
        bilan.colis_nouveaux += ins.length;
        for (const x of ins) await evenement(c.numero, 'colis appris', `${x.transporteur} ${x.code} : créé dans le BO (source : BO)`);
      }
      if (!r.erreurs.length || r.colis.length) await q('UPDATE commandes_bo SET colis_bo_vu_le = now(), colis_bo_trouves = $2 WHERE numero = $1', [c.numero, r.colis.length]);
      else await q("UPDATE commandes_bo SET colis_bo_vu_le = now() - interval '110 minutes' WHERE numero = $1", [c.numero]); // erreur : réessai dans ~10 min
    }));
    bilan.commandes += lot.length;
  }
  return bilan;
}

// ---------- 3. relire chez les transporteurs les colis pas encore finis ----------
async function relireTransporteurs(finA) {
  const bilan = {};
  await q(`UPDATE colis SET fini = true WHERE NOT fini AND coalesce(date_creation, maj_le) < now() - ($1 || ' days')::interval`, [JOURS]);
  // commandes terminées dans le BO (Livrée, Retour, annulée) : leurs colis ne sont plus relus (moins d'appels aux transporteurs).
  // Exception : commande en retour avec un autre colis encore en route (s'il est livré, elle passera en Livrée — double expédition).
  await q(`UPDATE colis c SET fini = true FROM commandes_bo b
            WHERE NOT c.fini AND b.numero = c.commande
              AND (coalesce(b.annulee, false) OR b.statut_code = 'Delevred'
                   OR (b.statut_code LIKE 'retour%' AND NOT EXISTS (SELECT 1 FROM colis k WHERE k.commande = c.commande AND NOT k.echange
                        AND (k.transporteur, k.code) <> (c.transporteur, c.code))))`);
  for (const [nom, t] of Object.entries(TRANSPORTEURS)) {
    if (!t.actif()) { bilan[nom] = 'non configuré'; continue; }
    let lus = 0;
    try {
      while (Date.now() < finA) {
        const codes = (await q(`SELECT code FROM colis WHERE transporteur = $1 AND NOT fini AND (suivi_le IS NULL OR suivi_le < now() - ($3 || ' minutes')::interval)
                                 ORDER BY suivi_le NULLS FIRST LIMIT $2`, [nom, t.lot, RELIRE_MIN])).map((r) => r.code);
        if (!codes.length) break;
        const res = await t.statuts(codes);
        await q('UPDATE colis SET suivi_le = now() WHERE transporteur = $1 AND code = ANY($2::text[])', [nom, codes]);
        // un même colis peut servir plusieurs commandes : le nouvel état s'applique à chacune
        const connus = await q('SELECT code, commande, date_creation, echange FROM colis WHERE transporteur = $1 AND code = ANY($2::text[])', [nom, res.map((r) => r.code)]);
        const parCode = new Map(res.map((r) => [r.code, r]));
        await enregistrerColis(connus.map((c) => { const r = parCode.get(c.code);
          return { transporteur: nom, ...r, commande: c.commande, echange: r.echange || c.echange, date_creation: r.date_creation || c.date_creation }; }), 'api');
        lus += codes.length;
      }
      bilan[nom] = lus;
    } catch (e) { bilan[nom] = 'erreur : ' + e.message; await alerte(null, `API ${nom}`, e.message); }
  }
  return bilan;
}

// ---------- 4. décider pour les commandes dont un colis a changé ----------
export async function evaluer(finA, max = 3000) {
  // les commandes sont « réservées » par lots (SKIP LOCKED) : deux passages simultanés ne traitent jamais la même commande
  const boComplet = (await reglage('bo_complet')) === 'oui'; // la liste du BO a été parcourue jusqu'au bout au moins une fois
  let evaluees = 0, enFile = 0, alertesN = 0, introuvables = 0;
  const liste = []; // commandes mises en file pendant ce passage (pour l'historique des passages)
  const vues = new Set(); // une commande remise en fin de liste n'est pas reprise dans le même passage
  while (evaluees < max && Date.now() < finA) {
    const lot = await q(`DELETE FROM a_evaluer WHERE commande IN (SELECT commande FROM a_evaluer ORDER BY depuis LIMIT 40 FOR UPDATE SKIP LOCKED)
                         RETURNING commande, depuis, premiere`);
    if (!lot.length) break;
    const remettre = [];
    const dejaVues = lot.every((it) => vues.has(it.commande));
    for (const it of lot) {
      if (Date.now() > finA || vues.has(it.commande)) { remettre.push(it); continue; }
      vues.add(it.commande);
      const { commande } = it;
      const bo = await q1('SELECT * FROM commandes_bo WHERE numero = $1', [commande]);
      evaluees++;
      if (!bo) {
        // commande pas encore vue dans la liste du BO : réessai (en fin de liste) pendant 3 jours, abandon si la liste a déjà été lue en entier
        if (!boComplet && new Date(it.premiere) > Date.now() - 3 * 864e5) remettre.push({ ...it, depuis: new Date() });
        introuvables++; continue;
      }
      const r = await evaluerUne(commande, bo);
      enFile += r.enFile; alertesN += r.alertes;
      if (r.enFile) liste.push({ commande, avant: bo.statut_code, apres: r.decision.cible, selon: `${r.decision.colis.transporteur} ${r.decision.colis.code}` });
    }
    if (remettre.length) await q(`INSERT INTO a_evaluer (commande, depuis, premiere) SELECT x.commande, x.depuis, x.premiere
        FROM json_to_recordset($1::json) AS x(commande text, depuis timestamptz, premiere timestamptz) ON CONFLICT DO NOTHING`, [JSON.stringify(remettre)]);
    if (dejaVues) break;
  }
  const reste = Number((await q1('SELECT count(*) n FROM a_evaluer')).n);
  return { evaluees, enFile, alertes: alertesN, introuvables, reste, liste };
}

// décision pour une commande ; met la file à jour et trace la décision
export async function evaluerUne(commande, bo) {
  const colis = await q('SELECT * FROM colis WHERE commande = $1', [commande]);
  const d = decider(colis, bo);
  for (const a of d.alertes) await alerte(commande, a.type, a.detail);
  // même décision déjà en file : la ligne garde sa place (seules les infos du colis sont rafraîchies) ; sinon elle est remplacée
  const deja = await q1("SELECT id, etat, cible FROM file WHERE commande = $1 AND etat IN ('attente', 'simule') ORDER BY id DESC LIMIT 1", [commande]);
  if (d.action === 'changer' && deja && deja.cible === d.cible) {
    await q(`UPDATE file SET attendu = $2, transporteur = $3, colis = $4, statut_transporteur = $5, preciser = $6, raison = $7 WHERE id = $1`,
      [deja.id, bo.statut_code, d.colis.transporteur, d.colis.code, d.colis.statut_brut, !!d.preciser, d.raison]);
    await q("DELETE FROM file WHERE commande = $1 AND etat IN ('attente', 'simule') AND id <> $2", [commande, deja.id]);
    return { decision: d, enFile: 0, alertes: d.alertes.length };
  }
  await q("DELETE FROM file WHERE commande = $1 AND etat IN ('attente', 'simule')", [commande]);
  if (d.action === 'changer') {
    await q(`INSERT INTO file (commande, bo_id, attendu, cible, transporteur, colis, statut_transporteur, preciser, raison)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (commande) WHERE etat = 'attente' DO NOTHING`,
      [commande, bo.id, bo.statut_code, d.cible, d.colis.transporteur, d.colis.code, d.colis.statut_brut, !!d.preciser, d.raison]);
    await evenement(commande, 'mis en file', `${LIBELLES[bo.statut_code] || bo.statut_code} → ${LIBELLES[d.cible]} selon ${d.colis.transporteur} ${d.colis.code} (${d.colis.statut_brut})`);
  } else if (colis.length) {
    const txt = d.action === 'alerte' ? `rien changé, alerte : ${d.alertes.map((a) => a.type).join(', ')}` : `rien à changer (statut BO : ${LIBELLES[bo.statut_code] || bo.statut_code})`;
    const der = await q1('SELECT detail FROM evenements WHERE commande = $1 ORDER BY id DESC LIMIT 1', [commande]);
    if (!der || der.detail !== txt) await evenement(commande, 'décision', txt); // pas de doublon
  }
  return { decision: d, enFile: d.action === 'changer' ? 1 : 0, alertes: d.alertes.length };
}

// « Vérifier maintenant » (écran de recherche) : relit tout pour UNE commande, puis décide
export async function verifierCommande(numero) {
  const bo = await q1('SELECT * FROM commandes_bo WHERE numero = $1', [numero]);
  if (!bo) return `${numero} : pas encore vue dans la liste du BO (attendre la prochaine collecte)`;
  const actu = await lireCommande(bo.id);
  if (!actu.erreur) await q('UPDATE commandes_bo SET statut_code = $2, annulee = $3, lu_le = now() WHERE numero = $1', [numero, actu.statut_code, actu.annulee]);
  const r = await colisDuBO(bo.id).catch(() => ({ colis: [] }));
  for (const c of r.colis) {
    const ins = await q(`INSERT INTO colis (transporteur, code, commande, statut_brut, cible, date_creation, source, suivi_le)
      VALUES ($1, $2, $3, $4, 'attente', $5, 'bo', NULL) ON CONFLICT DO NOTHING RETURNING code`, [c.transporteur, c.code, numero, `Colis créé dans le BO (${c.etat_bo})`, c.date_creation]);
    if (ins.length) await evenement(numero, 'colis appris', `${c.transporteur} ${c.code} : créé dans le BO (source : BO)`);
  }
  await q('UPDATE commandes_bo SET colis_bo_vu_le = now(), colis_bo_trouves = $2 WHERE numero = $1', [numero, r.colis.length]);
  const connus = await q('SELECT * FROM colis WHERE commande = $1', [numero]);
  for (const [nom, t] of Object.entries(TRANSPORTEURS)) {
    const mes = connus.filter((c) => c.transporteur === nom);
    if (!mes.length || !t.actif()) continue;
    const res = await t.statuts(mes.map((c) => c.code)).catch(() => []);
    await q('UPDATE colis SET suivi_le = now() WHERE transporteur = $1 AND commande = $2', [nom, numero]);
    await enregistrerColis(res.map((x) => { const k = mes.find((c) => c.code === x.code) || {};
      return { transporteur: nom, ...x, commande: numero, echange: x.echange || k.echange, date_creation: x.date_creation || k.date_creation }; }), 'vérification');
  }
  const bo2 = await q1('SELECT * FROM commandes_bo WHERE numero = $1', [numero]);
  const e = await evaluerUne(numero, bo2);
  await q('DELETE FROM a_evaluer WHERE commande = $1', [numero]);
  const d = e.decision;
  const txt = d.action === 'changer' ? `mise en file : ${LIBELLES[bo2.statut_code] || bo2.statut_code} → ${LIBELLES[d.cible]}` : d.action === 'alerte' ? 'alerte (voir ci-dessous)' : 'rien à changer';
  await evenement(numero, 'vérification', `vérifiée à la main : ${connus.length} colis, ${txt}`);
  await passage('vérifier', { colis: connus.length }, 'bouton', [{ commande: numero, avant: bo2.statut_code, apres: d.action === 'changer' ? d.cible : bo2.statut_code, resultat: txt }]);
  return `${numero} vérifiée : ${connus.length} colis connu(s) — ${txt}`;
}

export async function collecte(declencheur = 'auto') {
  // une seule collecte à la fois (cron 10 min, rattrapage chaque minute, bouton) : sinon on relirait deux fois les mêmes colis
  await q("INSERT INTO reglages VALUES ('verrou_collecte', '2000-01-01') ON CONFLICT DO NOTHING");
  const pris = await q1(`UPDATE reglages SET valeur = now()::text WHERE cle = 'verrou_collecte' AND valeur::timestamptz < now() - interval '55 seconds' RETURNING 1`);
  if (!pris) return { deja_en_cours: true };
  const fin = Date.now() + 50_000;
  const bilan = {};
  try { bilan.commandes_bo = await majCommandesBO(Date.now() + 12_000); } catch (e) { bilan.commandes_bo = 'erreur : ' + e.message; await alerte(null, 'API back-office', e.message); }
  try { bilan.colis_bo = await decouvrirColisBO(Date.now() + 12_000); } catch (e) { bilan.colis_bo = 'erreur : ' + e.message; }
  bilan.transporteurs = await relireTransporteurs(Date.now() + 18_000);
  const { liste, ...decisions } = await evaluer(fin);
  bilan.decisions = decisions;
  await passage('collecte', bilan, declencheur, liste);
  return bilan;
}

// ---------- 5. appliquer la file : ≤ 11 par minute, ≤ 700 par heure, espacés ----------
function note(item) {
  const d = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (item.transporteur === 'annulation') return `Annulation de la mise à jour automatique (synchro du ${d})`;
  return `Statut mis à jour selon le ${item.transporteur} (synchro du ${d})`;
}

export async function envoi(declencheur = 'auto') {
  const debut = Date.now();
  if ((await reglage('pause')) === 'oui') return { pause: true };
  const mode = await reglage('mode', 'simulation');
  if (mode !== 'reel') {
    // simulation : on note ce qui serait fait, sans appeler le BO
    const items = await q("SELECT * FROM file WHERE etat = 'attente' ORDER BY id LIMIT 200");
    for (const it of items) {
      await q(`INSERT INTO journal (mode, commande, bo_id, avant, apres, transporteur, colis, note, ok, resultat) VALUES ('simulation', $1, $2, $3, $4, $5, $6, $7, true, 'simulé')`,
        [it.commande, it.bo_id, it.attendu, it.cible, it.transporteur, it.colis, note(it)]);
      await q("UPDATE file SET etat = 'simule', traite_le = now() WHERE id = $1", [it.id]);
    }
    await passage('envoi', { mode, simules: items.length }, declencheur, items.map((it) => ({ commande: it.commande, avant: it.attendu, apres: it.cible, resultat: 'simulé' })));
    return { mode, simules: items.length };
  }
  const faitsHeure = Number((await q1("SELECT count(*) n FROM journal WHERE mode = 'reel' AND date > now() - interval '1 hour'")).n);
  const quota = Math.max(0, Math.min(11, LIMITE_HEURE - faitsHeure));
  const items = quota ? await q(`SELECT * FROM file WHERE etat = 'attente' ORDER BY (cible <> '${EN_COURS}'), id LIMIT $1`, [quota]) : []; // d'abord « Non traitée / validée… → Livraison en cours » (logistique à jour), puis Livrée / Retour
  const ecart = Math.floor(3_600_000 / LIMITE_HEURE); // ~5,1 s pour 700 / h
  const bilan = { mode, quota, faits: 0, deja: 0, refuses: 0, ignores: 0, erreurs: 0 };
  let dernier = 0;
  const liste = [];
  for (const it of items) {
    if (Date.now() - debut > 48_000) break;
    const pret = await verifier(it);
    if (pret.etat) { bilan[pret.etat === 'deja' ? 'deja' : pret.etat === 'erreur' ? 'erreurs' : 'ignores']++;
      liste.push({ commande: it.commande, avant: it.attendu, apres: it.cible, resultat: pret.resultat }); continue; }
    const attente = dernier + ecart * (0.8 + Math.random() * 0.4) - Date.now();
    if (attente > 0) await dormir(attente);
    const r = await appliquer(it, pret.actu);
    dernier = Date.now();
    if (r.ok) bilan.faits++; else bilan.refuses++;
    liste.push({ commande: it.commande, avant: r.avant, apres: it.cible, resultat: r.ok ? 'changé ✓' : 'refusé : ' + r.resultat });
  }
  await passage('envoi', bilan, declencheur, liste);
  return bilan;
}

// relit la commande dans le BO juste avant : renvoie { actu } si le changement est permis, sinon { etat } (ligne de file mise à jour)
async function verifier(it) {
  const actu = await lireCommande(it.bo_id);
  const fin = async (etat, resultat) => { await q('UPDATE file SET etat = $2, resultat = $3, traite_le = now() WHERE id = $1', [it.id, etat, resultat]); return { etat, resultat }; };
  if (actu.erreur) return fin('erreur', actu.erreur);
  if (actu.numero && String(actu.numero) !== String(it.commande)) return fin('erreur', `l'identifiant correspond à ${actu.numero}`);
  if (actu.statut_code === it.cible) return fin('deja', 'déjà au bon statut');
  const permis = it.preciser ? actu.statut_code === it.attendu : AMONT.has(actu.statut_code);
  if (!permis || actu.annulee) return fin('ignore', `statut actuel ${actu.statut_code}${actu.annulee ? ', commande annulée' : ''}`);
  return { actu };
}
// force le statut (uniquement force-status), relit pour vérifier, écrit le journal
async function appliquer(it, actu) {
  const n = note(it);
  const { code, msg } = await forcerStatut(it.bo_id, it.cible, actu.statut_code, n);
  const apres = await lireCommande(it.bo_id);
  const ok = apres.statut_code === it.cible;
  await q(`INSERT INTO journal (mode, commande, bo_id, avant, apres, transporteur, colis, note, ok, resultat) VALUES ('reel', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [it.commande, it.bo_id, actu.statut_code, it.cible, it.transporteur, it.colis, n, ok, `HTTP ${code} ${msg}`]);
  await q('UPDATE file SET etat = $2, resultat = $3, traite_le = now() WHERE id = $1', [it.id, ok ? 'fait' : (/annul/i.test(msg) ? 'annulee' : 'refuse'), `HTTP ${code} ${msg}`]);
  if (ok) await q('UPDATE commandes_bo SET statut_code = $2 WHERE numero = $1', [it.commande, it.cible]);
  await evenement(it.commande, ok ? 'statut changé dans le BO' : 'changement refusé', `${LIBELLES[actu.statut_code] || actu.statut_code} → ${LIBELLES[it.cible] || it.cible} (HTTP ${code} ${msg})`);
  return { ok, avant: actu.statut_code, apres: apres.statut_code, resultat: `HTTP ${code} ${msg}` };
}
// test : applique EN RÉEL une seule ligne de la file (attente ou simulée), quel que soit le mode
export async function appliquerUn(id) {
  const it = await q1("SELECT * FROM file WHERE id = $1 AND etat IN ('attente','simule')", [id]);
  if (!it) throw new Error('ligne introuvable ou déjà traitée');
  const pret = await verifier(it);
  if (pret.etat) return `${it.commande} : rien changé (${pret.resultat})`;
  const r = await appliquer(it, pret.actu);
  await passage('appliquer', { faits: r.ok ? 1 : 0 }, 'bouton', [{ commande: it.commande, avant: r.avant, apres: it.cible, resultat: r.ok ? 'changé ✓' : 'refusé : ' + r.resultat }]);
  return `${it.commande} : ${LIBELLES[r.avant] || r.avant} → ${LIBELLES[r.apres] || r.apres} ${r.ok ? '✓ changé dans le BO' : '✗ refusé (' + r.resultat + ')'}`;
}

// ---------- rattrapage « tout synchroniser » ----------
// Relit TOUT (liste complète du BO, tous les colis en cours, colis créés dans le BO) et réévalue toutes les commandes suivies.
// Pendant la durée choisie, une collecte tourne chaque minute (via la tâche « décision ») au lieu de toutes les 10 min.
// L'envoi vers le BO garde son rythme protégé (≤ 700 / heure, espacés) : le back-office et le serveur de mails ne sont pas surchargés.
export async function lancerRattrapage(minutes = 30) {
  const jusqua = new Date(Date.now() + minutes * 60_000);
  await fixer('rattrapage_jusqua', jusqua.toISOString());
  await fixer('bo_curseur', '3'); await fixer('bo_complet', 'non');
  const c = await q('UPDATE colis SET suivi_le = NULL WHERE NOT fini RETURNING 1');
  await q(`UPDATE commandes_bo SET colis_bo_vu_le = NULL WHERE NOT coalesce(annulee, false) AND statut_code = ANY($1::text[])
            AND (colis_cree_le > now() - ($2 || ' days')::interval OR cree_le > now() - interval '7 days')`, [[...AMONT], JOURS]);
  const e = await q('INSERT INTO a_evaluer (commande) SELECT DISTINCT commande FROM colis WHERE NOT fini ON CONFLICT DO NOTHING RETURNING 1');
  await passage('rattrapage', { jusqua, colis: c.length, commandes: e.length }, 'bouton');
  return `Rattrapage lancé jusqu'à ${jusqua.toLocaleTimeString('fr-FR', { timeZone: 'Africa/Tunis', hour: '2-digit', minute: '2-digit' })} : ${c.length} colis à relire, ${e.length} commandes à réévaluer, liste du BO relue en entier. Envoi au rythme normal (≤ ${LIMITE_HEURE} / heure).`;
}
export async function arreterRattrapage() { await fixer('rattrapage_jusqua', ''); return 'Rattrapage arrêté : retour au rythme normal.'; }
export async function rattrapageActif() {
  const j = await reglage('rattrapage_jusqua', '');
  return j && new Date(j) > new Date() ? new Date(j) : null;
}

export async function changerMode(mode) {
  await fixer('mode', mode === 'reel' ? 'reel' : 'simulation');
  if (mode === 'reel') await q("UPDATE file SET etat = 'attente', traite_le = NULL WHERE etat = 'simule'"); // les changements simulés deviennent réels
}
export async function annulerJournal(id) {
  const j = await q1("SELECT * FROM journal WHERE id = $1 AND mode = 'reel' AND ok AND NOT annule", [id]);
  if (!j) throw new Error('ligne introuvable, simulée, échouée ou déjà annulée');
  await q("DELETE FROM file WHERE commande = $1 AND etat = 'attente'", [j.commande]);
  await q(`INSERT INTO file (commande, bo_id, attendu, cible, transporteur, colis, statut_transporteur, preciser, raison)
           VALUES ($1, $2, $3, $4, 'annulation', $5, $6, true, $7)`, [j.commande, j.bo_id, j.apres, j.avant, j.colis, `annulation du journal n° ${j.id}`, `retour à ${LIBELLES[j.avant] || j.avant}`]);
  await q('UPDATE journal SET annule = true WHERE id = $1', [id]);
}
