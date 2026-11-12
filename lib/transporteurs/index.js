// Lecture des statuts chez les transporteurs, par lots de codes connus. Lecture seule : aucun colis créé ni modifié.
import crypto from 'crypto';
import { cibleBigBoss, cibleAfex, cibleAramex, cibleDrestDelivery, numeros } from '../regles';

const UA = { 'User-Agent': 'Drest-Synchro/1.0 (+https://www.drest.tn)', Accept: 'application/json' };
const URL_BB = process.env.BIGBOSS_URL || 'https://my.bigbossexpress.tn';
const URL_AFEX = process.env.AFEX_URL || 'https://apis.afex.tn';
const URL_ARAMEX = process.env.ARAMEX_URL || 'https://ws.aramex.net';
const avecDelai = (ms, p) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('délai dépassé')), ms))]);

// ---------- Big Boss ----------
export const bigboss = {
  nom: 'Big Boss', lot: 50,
  actif: () => !!(process.env.BIGBOSS_UTILISATEUR && process.env.BIGBOSS_PASS),
  async statuts(codes) {
    const r = await avecDelai(20000, fetch(`${URL_BB}/api/rest/StColis/ListColis`, {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ Utilisateur: process.env.BIGBOSS_UTILISATEUR, Pass: process.env.BIGBOSS_PASS, codeBar: codes.join(';') }) }));
    const js = await r.json();
    if (js.result_type === 'erreur') throw new Error(`Big Boss : ${js.result_code} ${js.result_content || ''}`);
    return (js.result_content?.colis || []).map((c) => ({
      code: String(c.code), commande: c.reference, statut_brut: `${c.etat} (${c.code_etat})`, cible: cibleBigBoss(c.code_etat, c.etat),
      echange: Number(c.echange) === 1, date_creation: c.date_creation ? c.date_creation + 'Z' : null }));
  },
};

// signature des webhooks Big Boss : sha256= HMAC-SHA256(secret, timestamp + "." + corps brut), 300 s max
export function webhookBigBossValide(corpsBrut, horodatage, signature) {
  const secret = process.env.BIGBOSS_WEBHOOK_SECRET;
  if (!secret || !horodatage || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(horodatage)) > 300) return false;
  const attendu = 'sha256=' + crypto.createHmac('sha256', secret).update(`${horodatage}.${corpsBrut}`).digest('hex');
  return attendu.length === signature.length && crypto.timingSafeEqual(Buffer.from(attendu), Buffer.from(signature));
}

// ---------- AFEX ----------
export const afex = {
  nom: 'AFEX', lot: 100,
  actif: () => !!process.env.AFEX_API_KEY,
  async statuts(codes) {
    const entetes = { ...UA, 'Content-Type': 'application/text', 'X-API-Key': process.env.AFEX_API_KEY };
    const lire = async (r) => {
      const txt = await r.text();
      if (r.status === 401 || r.status === 403) throw new Error(`AFEX : accès refusé (HTTP ${r.status})`);
      try { return JSON.parse(txt); } catch (e) { throw new Error(`AFEX : réponse illisible (HTTP ${r.status}) : ${txt.slice(0, 150)}`); }
    };
    const forme = (s) => ({ code: String(s.barcode ?? s.shipmentId ?? s.code), statut_brut: `${s.state}${s.delivered_state ? ' / ' + s.delivered_state : ''}${s.motif ? ' — ' + s.motif : ''}`,
      cible: cibleAfex(s.state, s.delivered_state) });
    const propres = codes.map((c) => String(c).trim().replace(/\.0$/, '')).filter(Boolean);
    try {
      const js = await lire(await avecDelai(20000, fetch(`${URL_AFEX}/v1/shipments/status`, { method: 'POST', headers: entetes, body: JSON.stringify({ shipmentIds: propres }) })));
      return (js.shipments || js.data || []).map(forme);
    } catch (e) {
      if (/accès refusé/.test(e.message)) throw e;
      // le lot est refusé : on essaie code par code (GET /v1/shipments/status/{code}) pour ne pas bloquer les autres colis
      const res = []; let erreurs = 0, derniere = e.message;
      for (const c of propres) {
        try {
          const js = await lire(await avecDelai(10000, fetch(`${URL_AFEX}/v1/shipments/status/${encodeURIComponent(c)}`, { headers: entetes })));
          const s = js.shipment || (Array.isArray(js.shipments) ? js.shipments[0] : js);
          if (s && s.state) res.push(forme({ barcode: c, ...s }));
        } catch (e2) { erreurs++; derniere = e2.message; }
      }
      if (!res.length && erreurs) throw new Error(derniere);
      return res;
    }
  },
};

// ---------- Aramex ----------
function dateAramex(s) { const m = /\/Date\((\d+)/.exec(String(s || '')); return m ? new Date(Number(m[1])).toISOString() : null; }
export const aramex = {
  nom: 'Aramex', lot: 50,
  actif: () => !!(process.env.ARAMEX_USERNAME && process.env.ARAMEX_PASSWORD && process.env.ARAMEX_ACCOUNT_PIN),
  async statuts(codes) {
    const corps = {
      ClientInfo: { UserName: process.env.ARAMEX_USERNAME, Password: process.env.ARAMEX_PASSWORD, Version: 'v1',
        AccountNumber: process.env.ARAMEX_ACCOUNT_NUMBER, AccountPin: process.env.ARAMEX_ACCOUNT_PIN,
        AccountEntity: process.env.ARAMEX_ACCOUNT_ENTITY || 'TUN', AccountCountryCode: process.env.ARAMEX_COUNTRY_CODE || 'TN', Source: 24 },
      GetLastTrackingUpdateOnly: true, Shipments: codes,
      Transaction: { Reference1: '', Reference2: '', Reference3: '', Reference4: '', Reference5: '' } };
    const r = await avecDelai(25000, fetch(`${URL_ARAMEX}/ShippingAPI.V2/Tracking/Service_1_0.svc/json/TrackShipments`, {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }));
    const js = await r.json();
    if (js.HasErrors) throw new Error('Aramex : ' + (js.Notifications || []).map((n) => `${n.Code} ${n.Message}`).join(' ; '));
    return (js.TrackingResults || []).map((t) => {
      const u = (t.Value || [])[0] || {};
      return { code: String(t.Key), statut_brut: `${u.UpdateCode} ${u.UpdateDescription}`, cible: cibleAramex(u.UpdateCode, u.UpdateDescription), date_statut: dateAramex(u.UpdateDateTime) };
    });
  },
};

// ---------- Drest Delivery (API REST Supabase / PostgREST, lecture seule) ----------
// DD_SUPABASE_URL = https://<PROJECT_REF>.supabase.co ; DD_SUPABASE_KEY = clé (lecture de la table colis). Seuls des GET sont faits.
const DD_LIBELLES = { PENDING: 'En attente', DISPATCHED: 'Affecté à un runsheet', OUT_FOR_DELIVERY: 'En tournée', DELIVERY_ATTEMPTED: 'Tentative échouée',
  DELIVERED: 'Livré', PAID: 'Livré et payé', PAID_RECEIVED: 'Paiement reçu', CANCELED: 'Annulé' };
const DD_COLONNES = 'id,tracking_code,num_commande,wp_order_id,statut,raison_echec,attempt_count,created_at,updated_at,date_creation';
function ddEntetes() { const k = process.env.DD_SUPABASE_KEY; return { ...UA, apikey: k, Authorization: `Bearer ${k}` }; }
async function ddGet(chemin) {
  const base = String(process.env.DD_SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const r = await avecDelai(20000, fetch(`${base}/rest/v1/${chemin}`, { headers: ddEntetes() }));
  const txt = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error(`Drest Delivery : accès refusé (HTTP ${r.status}) ${txt.slice(0, 120)}`);
  if (!r.ok) throw new Error(`Drest Delivery : HTTP ${r.status} ${txt.slice(0, 150)}`);
  try { return JSON.parse(txt); } catch (e) { throw new Error(`Drest Delivery : réponse illisible ${txt.slice(0, 120)}`); }
}
function ddColis(c) {
  const refs = numeros(c.num_commande).length ? numeros(c.num_commande) : (c.wp_order_id ? numeros(String(c.wp_order_id)) : []);
  const brut = `${DD_LIBELLES[c.statut] || c.statut} (${c.statut})${c.raison_echec ? ' — ' + c.raison_echec : ''}`;
  return refs.map((n) => ({ transporteur: 'Drest Delivery', code: String(c.tracking_code || c.id), commande: n, statut_brut: brut,
    cible: cibleDrestDelivery(c.statut), date_creation: c.created_at || null, date_statut: c.updated_at || null }));
}
export const drestDelivery = {
  nom: 'Drest Delivery', lot: 100,
  actif: () => !!(process.env.DD_SUPABASE_URL && process.env.DD_SUPABASE_KEY),
  async statuts(codes) {
    const liste = codes.filter((c) => !String(c).startsWith('MODELE-')).map((c) => `"${String(c).replace(/"/g, '')}"`).join(',');
    if (!liste) return [];
    const js = await ddGet(`colis?select=${DD_COLONNES}&tracking_code=in.(${encodeURIComponent(liste)})`);
    return js.map((c) => { const x = ddColis(c)[0]; return x ? { code: x.code, statut_brut: x.statut_brut, cible: x.cible, date_statut: x.date_statut } : null; }).filter(Boolean);
  },
  // colis créés ou modifiés depuis une date (liste complète, paginée par 1000) : c'est ce qui rend Drest Delivery automatique
  async depuis(dateIso, finA) {
    const out = []; let offset = 0, dernier = dateIso;
    while (Date.now() < finA) {
      const js = await ddGet(`colis?select=${DD_COLONNES}&updated_at=gte.${encodeURIComponent(dateIso)}&order=updated_at.asc,id.asc&limit=1000&offset=${offset}`);
      for (const c of js) { out.push(...ddColis(c)); if (c.updated_at && c.updated_at > dernier) dernier = c.updated_at; }
      if (js.length < 1000) return { colis: out, dernier, complet: true };
      offset += 1000;
    }
    return { colis: out, dernier, complet: false };
  },
};

export const TRANSPORTEURS = { 'Big Boss': bigboss, AFEX: afex, Aramex: aramex, 'Drest Delivery': drestDelivery };
