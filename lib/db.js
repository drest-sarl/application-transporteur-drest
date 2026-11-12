// Base Postgres (Neon sur Vercel). Une seule connexion par fonction, tables créées automatiquement au 1er appel.
import pg from 'pg';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL;
let pool = globalThis.__drestPool;
if (!pool) {
  pool = new pg.Pool({
    connectionString: url,
    max: 2,
    ssl: url && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : false,
  });
  globalThis.__drestPool = pool;
}

export async function q(sql, params = []) {
  await init();
  return (await pool.query(sql, params)).rows;
}
export async function q1(sql, params = []) { return (await q(sql, params))[0] || null; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reglages (cle text PRIMARY KEY, valeur text);
INSERT INTO reglages VALUES ('mode','simulation'), ('pause','non') ON CONFLICT DO NOTHING;

-- un colis connu chez un transporteur, avec son dernier état
CREATE TABLE IF NOT EXISTS colis (
  transporteur text NOT NULL, code text NOT NULL, commande text NOT NULL DEFAULT '',
  statut_brut text, cible text, date_creation timestamptz, date_statut timestamptz,
  echange boolean DEFAULT false, fini boolean DEFAULT false, source text,
  maj_le timestamptz DEFAULT now(), suivi_le timestamptz,
  PRIMARY KEY (transporteur, code, commande)); -- un colis peut regrouper plusieurs commandes
CREATE INDEX IF NOT EXISTS colis_commande ON colis (commande);
CREATE INDEX IF NOT EXISTS colis_suivi ON colis (fini, suivi_le NULLS FIRST);

-- commandes dont un colis a changé : à réévaluer
CREATE TABLE IF NOT EXISTS a_evaluer (commande text PRIMARY KEY, depuis timestamptz DEFAULT now(), premiere timestamptz DEFAULT now());
ALTER TABLE a_evaluer ADD COLUMN IF NOT EXISTS premiere timestamptz DEFAULT now();

-- copie légère des commandes du BO (id, statut) tenue à jour en parcourant la liste
CREATE TABLE IF NOT EXISTS commandes_bo (
  numero text PRIMARY KEY, id text, statut_code text, statut text, annulee boolean,
  colis_cree_le timestamptz, cree_le timestamptz, lu_le timestamptz DEFAULT now());
-- découverte des n° de colis créés depuis le BO (routes /shipments/…)
ALTER TABLE commandes_bo ADD COLUMN IF NOT EXISTS colis_bo_vu_le timestamptz;
ALTER TABLE commandes_bo ADD COLUMN IF NOT EXISTS colis_bo_trouves int DEFAULT 0;

-- changements de statut à appliquer (≤ 700 / heure)
CREATE TABLE IF NOT EXISTS file (
  id serial PRIMARY KEY, commande text NOT NULL, bo_id text, attendu text, cible text NOT NULL,
  transporteur text, colis text, statut_transporteur text, preciser boolean DEFAULT false,
  raison text, cree_le timestamptz DEFAULT now(),
  etat text DEFAULT 'attente', resultat text, traite_le timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS file_une_attente ON file (commande) WHERE etat = 'attente';

-- tout ce qui a été changé (ou simulé) dans le BO
CREATE TABLE IF NOT EXISTS journal (
  id serial PRIMARY KEY, date timestamptz DEFAULT now(), mode text, commande text, bo_id text,
  avant text, apres text, transporteur text, colis text, note text, ok boolean, resultat text, annule boolean DEFAULT false);
CREATE INDEX IF NOT EXISTS journal_date ON journal (date);

CREATE TABLE IF NOT EXISTS alertes (
  id serial PRIMARY KEY, date timestamptz DEFAULT now(), commande text, type text, detail text, vue boolean DEFAULT false);
CREATE UNIQUE INDEX IF NOT EXISTS alertes_uniques ON alertes (commande, type) WHERE vue = false;

CREATE TABLE IF NOT EXISTS webhooks_recus (id text PRIMARY KEY, recu_le timestamptz DEFAULT now(), evenement text, corps jsonb);

-- historique par commande (colis appris / changé, décision, vérification) : consultable par n° de commande
CREATE TABLE IF NOT EXISTS evenements (id serial PRIMARY KEY, date timestamptz DEFAULT now(), commande text, type text, detail text);
CREATE INDEX IF NOT EXISTS evenements_commande ON evenements (commande, date);

-- décision du 12/11 : statut transporteur inconnu = livraison en cours (reprise des colis déjà notés « inconnu »)
INSERT INTO a_evaluer (commande) SELECT DISTINCT commande FROM colis WHERE cible = 'inconnu' AND statut_brut <> '' ON CONFLICT DO NOTHING;
UPDATE colis SET cible = 'Livraison-en-cours' WHERE cible = 'inconnu' AND statut_brut <> '';
UPDATE alertes SET vue = true WHERE type = 'statut inconnu' AND NOT vue;

CREATE TABLE IF NOT EXISTS passages (id serial PRIMARY KEY, date timestamptz DEFAULT now(), type text, resume text);
`;

let pret = globalThis.__drestDbPret;
async function init() {
  if (pret) return pret;
  if (!url) throw new Error('DATABASE_URL manquante : relier la base Neon au projet Vercel');
  // en cas d'échec (base momentanément injoignable), on réessaiera au prochain appel
  pret = pool.query(SCHEMA).then(() => true, (e) => { pret = globalThis.__drestDbPret = null; throw e; });
  globalThis.__drestDbPret = pret;
  return pret;
}

export async function reglage(cle, defaut = null) {
  const r = await q1('SELECT valeur FROM reglages WHERE cle = $1', [cle]);
  return r ? r.valeur : defaut;
}
export async function fixer(cle, valeur) {
  await q('INSERT INTO reglages VALUES ($1, $2) ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur', [cle, String(valeur)]);
}
export async function passage(type, resume) {
  await q('INSERT INTO passages (type, resume) VALUES ($1, $2)', [type, typeof resume === 'string' ? resume : JSON.stringify(resume)]);
  await q("DELETE FROM passages WHERE date < now() - interval '7 days'");
  await q("DELETE FROM evenements WHERE date < now() - interval '60 days'");
}
export async function alerte(commande, type, detail) {
  await q('INSERT INTO alertes (commande, type, detail) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [commande || '—', type, detail]);
}
export async function evenement(commande, type, detail) {
  await q('INSERT INTO evenements (commande, type, detail) VALUES ($1, $2, $3)', [commande, type, detail]);
}
