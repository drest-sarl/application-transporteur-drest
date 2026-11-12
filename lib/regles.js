// Règles de statut — reprises des mises à jour par fichiers (octobre-novembre 2026) et des décisions du 11/11.
// Cibles possibles (codes BO) : 'Livraison-en-cours', 'Delevred', 'retour-expediteur'.
// Valeurs internes : 'attente' (colis créé, pas parti), 'ignore' (échange / récupération), 'perdu', 'inconnu'.

export const LIVRE = 'Delevred', RETOUR = 'retour-expediteur', EN_COURS = 'Livraison-en-cours';
export const LIBELLES = { Delevred: 'Livrée', 'retour-expediteur': 'Retour expéditeur', 'Livraison-en-cours': 'Livraison en cours' };

// statuts BO qu'on a le droit de faire avancer (tout le reste = final ou hors circuit transporteur : jamais touché)
export const AMONT = new Set(['attente_enlevement', 'Untreated', 'Valid', 'Inprogress', 'DEPOSIT', 'Confirmed', 'COLLECTED_BY_COURIER',
  'Collected', 'Livraison-en-cours', 'PrintQR', 'SCANNED', 'SCANNED_BY_DREST']);

// n° de commande : DR-AAMMJJ-NNNNN, ou ancien n° WordPress à 7 chiffres ; Drest Delivery : CMD-WC-<n° WP>
export function numeros(texte) {
  const t = String(texte || '');
  const wc = t.match(/CMD-WC-(\d{7})/);
  if (wc) return [wc[1]];
  return [...new Set(t.match(/DR-\d{6}-\d{4,6}|(?<!\d)\d{7}(?!\d)/g) || [])];
}

// ---------- Big Boss : code_etat (listEtats) ----------
export function cibleBigBoss(code, libelle = '') {
  const c = code === null || code === undefined || code === '' ? NaN : Number(code);
  if (c === 5) return LIVRE;
  if (c === 6) return RETOUR;
  if ([0, 1, 2, 3, 4].includes(c)) return EN_COURS; // 0 En attente, 1 Enlevé, 2 Au dépôt, 3 En livraison, 4 Retour dépôt (pas encore final)
  const l = String(libelle).toLowerCase();
  if (/^livr/.test(l)) return LIVRE;
  if (/retour exp/.test(l) || l === 'retour') return RETOUR;
  if (l) return EN_COURS;
  return 'inconnu';
}

// ---------- AFEX : state ----------
const AFEX = {
  delivered: LIVRE,
  pre_manifest: EN_COURS, pending: EN_COURS, awaiting_removal: EN_COURS, being_removed: EN_COURS,
  awaiting_delivery: EN_COURS, in_delivery: EN_COURS, awaiting_transfert: EN_COURS, in_transfert: EN_COURS, transfered: EN_COURS, anomaly: EN_COURS,
  awaiting_return: RETOUR, being_returned: RETOUR, awaiting_rto: RETOUR, in_rto: RETOUR, returned: RETOUR, canceled: RETOUR,
  exception_refunded: 'perdu', exception_not_refunded: 'perdu',
  awaiting_recovered: 'ignore', being_recovered: 'ignore', recovered: 'ignore', not_recovered: 'ignore',
};
export function cibleAfex(state, deliveredState) {
  // « Retourné » alors que la livraison dit « Livré » : contradiction → alerte (règle des fichiers)
  if (state === 'returned' && deliveredState === 'delivered') return 'contradiction';
  return AFEX[state] || (state ? EN_COURS : 'inconnu'); // décision du 12/11 : statut non listé = livraison en cours
}
// libellés français des exports AFEX (« Statut actuel » / « Statut de livraison »)
export function cibleAfexFichier(actuel, livraison) {
  const a = String(actuel || ''), l = String(livraison || '');
  if (/r[ée]cup/i.test(l)) return 'ignore';
  if (/^livr/i.test(a)) return LIVRE;
  if (/^retourn/i.test(a)) return /^livr/i.test(l) ? 'contradiction' : RETOUR;
  if (/annul/i.test(a)) return RETOUR;
  return a ? EN_COURS : 'inconnu';
}

// ---------- Aramex : UpdateCode / libellé ----------
const ARAMEX_CODES = { SH005: LIVRE, SH239: LIVRE, SH014: EN_COURS, SH047: EN_COURS, SH003: EN_COURS, SH515: EN_COURS };
export function cibleAramex(code, description = '') {
  if (ARAMEX_CODES[code]) return ARAMEX_CODES[code];
  const d = String(description).toLowerCase();
  if (/^(delivered|paid|paid_received)$/.test(d) || /charges paid|^delivered\b/.test(d)) return LIVRE;
  if (/returned|refused|return to shipper|rts/.test(d)) return RETOUR;
  // décision du 12/11 : tout autre statut (SH001 Under processing, SH296 Address Corrected, SH516 Customer contacted…) = livraison en cours
  return d || code ? EN_COURS : 'inconnu';
}

// ---------- Drest Delivery (export) ----------
export function cibleDrestDelivery(statut) {
  const s = String(statut || '').trim();
  // codes de l'API (Supabase) : PENDING, DISPATCHED, OUT_FOR_DELIVERY, DELIVERY_ATTEMPTED, DELIVERED, PAID, PAID_RECEIVED, CANCELED
  if (/^(DELIVERED|PAID|PAID_RECEIVED)$/.test(s)) return LIVRE;
  if (s === 'CANCELED') return RETOUR; // décision du 11/11 : annulé chez Drest Delivery = retour vers expéditeur
  if (s === 'PENDING') return 'attente';
  if (/^(DISPATCHED|OUT_FOR_DELIVERY|DELIVERY_ATTEMPTED)$/.test(s)) return EN_COURS;
  if (/^(PAID_RECEIVED|Livré|Payé)$/i.test(s)) return LIVRE;
  if (/^annul/i.test(s)) return RETOUR; // décision du 11/11 : Annulé chez Drest Delivery = retour vers expéditeur
  if (/^en attente$/i.test(s)) return 'attente';
  return s ? EN_COURS : 'inconnu';
}

/*
 * Décision pour UNE commande à partir de tous ses colis connus.
 * colis : [{transporteur, code, cible, statut_brut, date_creation, echange}]
 * bo    : {statut_code, annulee}
 * Retour : { action: 'rien' | 'changer' | 'alerte', cible, colis, preciser, raison, alertes: [{type, detail}] }
 */
export function decider(colisListe, bo) {
  const alertes = [];
  const tri = [...colisListe].filter((c) => !c.echange && c.cible !== 'ignore')
    .sort((a, b) => new Date(a.date_creation || 0) - new Date(b.date_creation || 0));
  const resume = tri.map((c) => `${c.transporteur} ${c.code} : ${c.statut_brut}`).join(' | ');
  if (!tri.length) return { action: 'rien', alertes };
  for (const c of tri) {
    if (c.cible === 'inconnu') alertes.push({ type: 'statut inconnu', detail: `${c.transporteur} ${c.code} : « ${c.statut_brut} » n'est pas dans la table de correspondance` });
    if (c.cible === 'perdu') alertes.push({ type: 'colis perdu', detail: `${c.transporteur} ${c.code} : ${c.statut_brut}` });
    if (c.cible === 'contradiction') alertes.push({ type: 'retour mais livré', detail: `${c.transporteur} ${c.code} : ${c.statut_brut}` });
  }
  // colis exploitables : sans les « en attente » Drest Delivery s'il existe un autre colis
  let utiles = tri.filter((c) => [LIVRE, RETOUR, EN_COURS, 'attente'].includes(c.cible));
  if (utiles.length > 1) utiles = utiles.filter((c) => c.cible !== 'attente') ;
  if (!utiles.length) return { action: alertes.length ? 'alerte' : 'rien', alertes };
  const transporteurs = new Set(tri.map((c) => c.transporteur));
  const livres = utiles.filter((c) => c.cible === LIVRE);
  const decisif = livres.length ? livres[livres.length - 1] : utiles[utiles.length - 1];
  let cible = decisif.cible === 'attente' ? EN_COURS : decisif.cible;
  // vraie double expédition : un colis autre que le dernier était encore actif ou livré (une réexpédition après retour est normale)
  const vraieDouble = transporteurs.size > 1 && utiles.slice(0, -1).some((c) => [LIVRE, EN_COURS, 'attente'].includes(c.cible));
  if (vraieDouble) {
    alertes.push({ type: 'double expédition', detail: `${livres.length ? 'statut selon le colis livré' : 'statut selon le dernier colis'} — ${resume}` });
    if (livres.length > 1) alertes.push({ type: 'livrée deux fois', detail: resume });
  }
  const cur = bo.statut_code;
  const base = { colis: decisif, alertes };
  if (bo.annulee) {
    if (cible === LIVRE) alertes.push({ type: 'commande annulée mais colis livré', detail: resume });
    return { ...base, action: alertes.length ? 'alerte' : 'rien' };
  }
  if (cur === cible) return { ...base, action: alertes.length ? 'alerte' : 'rien' };
  if (!AMONT.has(cur)) {
    // statut final dans le BO : jamais touché, sauf « retour » alors qu'un colis est livré → Livrée (décision du 12/11 :
    // la commande a été expédiée deux fois, un colis retourné et un livré — même transporteur ou non)
    if (String(cur).startsWith('retour') && cible === LIVRE) {
      if (tri.length > 1 && !alertes.some((a) => a.type === 'double expédition')) alertes.push({ type: 'double expédition', detail: `retour puis livrée — ${resume}` });
      return { ...base, action: 'changer', cible, preciser: true, raison: tri.length > 1 ? 'double expédition : un colis retourné, un colis livré' : 'retour dans le BO mais colis livré' };
    }
    // « Livrée » dans le BO mais l'UNIQUE colis est retourné → Retour expéditeur (décision du 12/11)
    if (cur === LIVRE && cible === RETOUR && tri.length === 1) {
      return { ...base, action: 'changer', cible, preciser: true, raison: 'livrée dans le BO mais le colis est retourné' };
    }
    if ((cur === LIVRE && cible === RETOUR) || (String(cur).startsWith('retour') && cible === LIVRE)) {
      alertes.push({ type: 'statut final contredit', detail: `BO : ${cur} — transporteur : ${resume}` });
    }
    return { ...base, action: alertes.length ? 'alerte' : 'rien' };
  }
  if (cur === EN_COURS && cible === EN_COURS) return { ...base, action: alertes.length ? 'alerte' : 'rien' };
  return { ...base, action: 'changer', cible, preciser: false, raison: `${decisif.transporteur} : ${decisif.statut_brut}` };
}
