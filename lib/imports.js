// Lecture des exports transporteurs déposés dans l'application (pour apprendre les codes Aramex / AFEX / Drest Delivery).
// Formats reconnus automatiquement par leurs en-têtes : rapport Aramex (TotalShipmentReport, feuille « Detailed Data »),
// fichier d'envoi en masse Aramex, Big Boss (colis_export), AFEX (Colis_transport), Drest Delivery (drest-export .csv, ou modèle template-import-colis).
import * as XLSX from 'xlsx';
import { numeros, cibleBigBoss, cibleAfexFichier, cibleAramex, cibleDrestDelivery } from './regles';

function lignes(ws) {
  const brut = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const i = brut.findIndex((l) => l.filter((c) => c != null && String(c).trim()).length >= 4);
  if (i < 0) return { entetes: [], donnees: [] };
  const entetes = brut[i].map((h) => String(h ?? '').trim());
  return { entetes, donnees: brut.slice(i + 1).filter((l) => l.some((c) => c != null && String(c).trim())) };
}
function date(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? new Date(Date.UTC(d.y, d.m - 1, d.d, d.H, d.M, d.S)).toISOString() : null; }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(v || '').trim());
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0) - 1, +(m[5] || 0), +(m[6] || 0))).toISOString(); // heure de Tunis (UTC+1)
  const d = new Date(v); return isNaN(d) ? null : d.toISOString();
}

export function lireExport(buffer, nomFichier) {
  const csv = /\.csv$/i.test(nomFichier || '');
  const wb = csv ? XLSX.read(buffer.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string', cellDates: false, raw: true })
                 : XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const feuilles = wb.SheetNames.includes('Detailed Data') ? ['Detailed Data'] : wb.SheetNames;
  for (const nom of feuilles) {
    const { entetes, donnees } = lignes(wb.Sheets[nom]);
    const col = (...noms) => entetes.findIndex((h) => noms.some((n) => h.toLowerCase() === n.toLowerCase()));
    const sortie = [];
    // ---- Aramex ----
    if (col('AWB') >= 0 && col('Status') >= 0) {
      const [cA, cS, cR, cD] = [col('AWB'), col('Status'), col('Consignee Reference 1'), col('Pickup Date (Creation Date)')];
      for (const l of donnees) {
        if (!l[cA]) continue;
        for (const n of numeros(l[cR])) sortie.push({ transporteur: 'Aramex', code: String(l[cA]), commande: n, statut_brut: String(l[cS] || ''),
          cible: cibleAramex(null, l[cS]), date_creation: date(l[cD]) });
      }
      return { type: 'Aramex', colis: sortie };
    }
    // ---- Aramex : fichier d'envoi en masse (Shipment Number, Shipment Reference, … Last Status) ----
    if (col('Shipment Number') >= 0 && col('Shipment Reference', 'Receiver Reference') >= 0) {
      const [cA, cR, cR2, cS, cD] = [col('Shipment Number'), col('Shipment Reference'), col('Receiver Reference'), col('Last Status'), col('Shipping Date')];
      for (const l of donnees) {
        if (!l[cA]) continue;
        const awb = String(l[cA]).trim().replace(/\.0$/, '');
        const refs = numeros(cR >= 0 ? l[cR] : '').length ? numeros(l[cR]) : numeros(cR2 >= 0 ? l[cR2] : '');
        const st = cS >= 0 && l[cS] ? String(l[cS]) : '';
        for (const n of refs) sortie.push({ transporteur: 'Aramex', code: awb, commande: n,
          statut_brut: st || 'Colis créé (envoi en masse Aramex)', cible: st ? cibleAramex(null, st) : 'attente', date_creation: date(l[cD]), nouveauSeulement: !st });
      }
      return { type: 'Aramex (envoi en masse)', colis: sortie };
    }
    // ---- Big Boss ----
    if (col('Code Barres') >= 0 && col('État', 'Etat') >= 0) {
      const [cC, cE, cP, cR, cD] = [col('Code Barres'), col('État', 'Etat'), col('Produits'), col('Référence Expéditeur', 'Reference Expediteur'), col('Date Commande')];
      for (const l of donnees) {
        if (!l[cC]) continue;
        const refs = numeros(cR >= 0 ? l[cR] : '').length ? numeros(l[cR]) : numeros(l[cP]);
        for (const n of refs) sortie.push({ transporteur: 'Big Boss', code: String(l[cC]), commande: n, statut_brut: String(l[cE] || ''),
          cible: cibleBigBoss(null, l[cE]), echange: /[ée]change/i.test(String(l[cP] || '')), date_creation: date(l[cD]) });
      }
      return { type: 'Big Boss', colis: sortie };
    }
    // ---- AFEX ----
    if (col('Code à barre', 'Code a barre') >= 0 && col('Statut actuel') >= 0) {
      const [cC, cD, cT, cA, cL, cR] = [col('Code à barre', 'Code a barre'), col('Date Manifest'), col("Type d'envoi"), col('Statut actuel'), col('Statut de livraison'), col('Réference', 'Référence', 'Reference')];
      for (const l of donnees) {
        if (!l[cC]) continue;
        for (const n of numeros(l[cR])) sortie.push({ transporteur: 'AFEX', code: String(l[cC]), commande: n, statut_brut: `${l[cA] || ''} / ${l[cL] || ''}`,
          cible: cibleAfexFichier(l[cA], l[cL]), echange: /[ée]change|r[ée]cup/i.test(String(l[cT] || '')), date_creation: date(l[cD]) });
      }
      return { type: 'AFEX', colis: sortie };
    }
    // ---- Drest Delivery : modèle d'import des colis (template-import-colis) = colis remis à Drest Delivery ----
    if (col('N° Commande') >= 0 && col('Expéditeur', 'Expediteur') >= 0 && col('Statut') < 0 && col('Tracking') < 0) {
      const cN = col('N° Commande');
      for (const l of donnees) {
        for (const n of numeros(l[cN])) sortie.push({ transporteur: 'Drest Delivery', code: `MODELE-${n}`, commande: n,
          statut_brut: 'Colis créé (modèle Drest Delivery)', cible: 'attente', date_creation: new Date().toISOString() });
      }
      return { type: 'Drest Delivery (modèle de colis)', colis: sortie };
    }
    // ---- Drest Delivery ----
    if (col('Tracking') >= 0 && col('N° Commande') >= 0) {
      const [cT, cN, cS, cD] = [col('Tracking'), col('N° Commande'), col('Statut'), col('Date Création')];
      for (const l of donnees) {
        if (!l[cT]) continue;
        for (const n of numeros(l[cN])) sortie.push({ transporteur: 'Drest Delivery', code: String(l[cT]), commande: n, statut_brut: String(l[cS] || ''),
          cible: cibleDrestDelivery(l[cS]), date_creation: date(l[cD]) });
      }
      return { type: 'Drest Delivery', colis: sortie };
    }
  }
  throw new Error(`format non reconnu (${nomFichier}) : rapport ou envoi en masse Aramex, export Big Boss, export AFEX, export ou modèle Drest Delivery attendu`);
}
