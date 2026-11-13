// Back-office Drest : connexion, lecture des commandes, et UNIQUEMENT « forcer un statut ».
// Aucun appel de modification de commande (/edit) n'existe dans cette application : articles, adresses, prix et frais ne sont jamais touchés.
import { reglage, fixer } from './db';

const BO = (process.env.BO_URL || 'https://bo.drest.tn').replace(/\/$/, '');
const ENT = { Accept: 'application/json', 'User-Agent': 'Drest-Synchro/1.0' };

function trouverJeton(o) {
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /token|jwt/i.test(k) && !/refresh/i.test(k) && v.length > 20) return v;
      const t = trouverJeton(v); if (t) return t;
    }
  }
  return null;
}

async function connexion() {
  if (!process.env.BO_LOGIN || !process.env.BO_PASSWORD) throw new Error('BO_LOGIN / BO_PASSWORD manquants');
  const champs = [...new Set([process.env.BO_LOGIN_FIELD || 'login', 'login', 'email', 'username'])];
  for (const champ of champs) {
    const r = await fetch(`${BO}/api/v1/admin/auth/login`, { method: 'POST', headers: { ...ENT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [champ]: process.env.BO_LOGIN, password: process.env.BO_PASSWORD }) });
    if (!r.ok) continue;
    const jeton = trouverJeton(await r.json().catch(() => null));
    if (jeton) { await fixer('bo_jeton', jeton); return jeton; }
  }
  throw new Error('connexion au back-office refusée (BO_LOGIN / BO_PASSWORD)');
}

async function appel(methode, chemin, corps) {
  let jeton = (await reglage('bo_jeton')) || (await connexion());
  for (let essai = 0; essai < 2; essai++) {
    const r = await fetch(BO + chemin, { method: methode, headers: { ...ENT, Authorization: `Bearer ${jeton}`, ...(corps ? { 'Content-Type': 'application/json' } : {}) },
      body: corps ? JSON.stringify(corps) : undefined });
    if (r.status === 401 && essai === 0) { jeton = await connexion(); continue; }
    const txt = await r.text();
    let js = null; try { js = JSON.parse(txt); } catch (e) { /* */ }
    return { code: r.status, js, txt };
  }
}

// statut actuel d'une commande (par son identifiant BO)
export async function lireCommande(id) {
  const { code, js } = await appel('GET', `/order-api/v1/admin/ordering/find/order/${encodeURIComponent(id)}`);
  if (code < 200 || code >= 300) return { erreur: `lecture impossible (HTTP ${code})` };
  const o = js?.objectResponse?.order || {};
  return { id: o.id || o._id || null, statut_code: o.statusCode, numero: o.number || o.orderNumber, annulee: !!(o.cancled || o.canceled) };
}

// Identifiant BO d'une commande ancienne connue seulement par son n° (export déposé) : la liste du BO est triée de la plus récente
// à la plus ancienne → recherche par dichotomie sur la date de création (≈ 8 pages lues), puis lecture des pages voisines.
export async function chercherIdParListe(numero, creeLe) {
  const cible = creeLe ? new Date(creeLe).getTime() : null;
  const taille = 100;
  const p1 = await pageCommandes(1, taille);
  const trouve = (cmds) => cmds.find((c) => String(c.number || c.orderNumber) === String(numero));
  let x = trouve(p1.commandes); if (x) return x;
  if (!cible || !p1.total) return null;
  const date = (c) => new Date(c.dateCreation || c.placedAt || 0).getTime();
  let bas = 1, haut = Math.ceil(p1.total / taille), essais = 0;
  while (bas < haut && essais++ < 12) {
    const m = Math.floor((bas + haut) / 2);
    const { commandes } = await pageCommandes(m, taille);
    if ((x = trouve(commandes))) return x;
    if (!commandes.length) { haut = m - 1; continue; }
    if (date(commandes[commandes.length - 1]) > cible) bas = m + 1; else haut = m;
  }
  for (const pg of [bas - 1, bas, bas + 1, bas + 2]) {
    if (pg < 1) continue;
    const { commandes } = await pageCommandes(pg, taille);
    if ((x = trouve(commandes))) return x;
  }
  return null;
}

// changement de statut seul : nouveau statut + statut attendu (le BO refuse si la commande a bougé entre-temps) + note
export async function forcerStatut(id, cible, attendu, note) {
  const { code, js, txt } = await appel('POST', `/order-api/v1/admin/ordering/order/${encodeURIComponent(id)}/force-status`,
    { codeStatus: cible, expectedStatusCode: attendu, note: String(note).slice(0, 300) });
  const msg = js && typeof js === 'object' ? `result=${js.result} ${js.errorDescription || js.message || ''}`.trim() : String(txt).slice(0, 200);
  return { code, msg };
}

// une page de la liste des commandes (les plus récentes d'abord ; le BO ignore les filtres)
export async function pageCommandes(page, taille = 100) {
  const { code, js } = await appel('GET', `/order-api/v1/admin/ordering/all/order?page=${page}&pageSize=${taille}`);
  if (code !== 200) throw new Error(`liste des commandes : HTTP ${code}`);
  const o = js?.objectResponse || {};
  return { commandes: o.content || [], dernier: !!o.last, total: o.totalElements };
}

// colis créés depuis le BO : GET /ordering/order/{id}/shipments/{bigboss|aramex|afex} → { shipment: { trackingNumber, createdAt, carrierStatus… } | null }
const ROUTES_COLIS = [['bigboss', 'Big Boss'], ['aramex', 'Aramex'], ['afex', 'AFEX']];
export async function colisDuBO(id) {
  const res = await Promise.all(ROUTES_COLIS.map(async ([route, transporteur]) => {
    const { code, js } = await appel('GET', `/order-api/v1/admin/ordering/order/${encodeURIComponent(id)}/shipments/${route}`);
    if (code !== 200) return { erreur: `${transporteur} HTTP ${code}` };
    const s = js?.shipment || js?.objectResponse?.shipment;
    const numero = s && (s.trackingNumber || s.barcode || s.awb);
    return numero ? { transporteur, code: String(numero), date_creation: s.createdAt || null, etat_bo: s.carrierStatus || s.state || '' } : null;
  }));
  return { colis: res.filter((r) => r && !r.erreur), erreurs: res.filter((r) => r && r.erreur).map((r) => r.erreur) };
}
