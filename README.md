# Synchro statuts Drest — guide de mise en ligne

Application qui met à jour **uniquement le statut** des commandes du back-office (`force-status`) selon Big Boss, AFEX, Aramex et Drest Delivery.
Elle ne touche jamais aux articles, adresses, prix ni frais. Au plus **700 changements par heure**, espacés de ~5 s. Démarre en **SIMULATION**.

## Comment elle fonctionne
| Quand | Quoi |
|---|---|
| En continu | **Big Boss** prévient l'application à chaque changement de colis (webhook signé) |
| Toutes les 10 min (`/api/sync/collecte`) | relit la liste des commandes du BO, **apprend les n° de colis créés depuis le BO**, relit chez les transporteurs les colis en cours (chacun au plus toutes les 8 min), décide, remplit la **file** |
| Chaque minute (`/api/sync/envoi`) | applique au plus 11 changements de la file (700 / heure). En simulation : note seulement ce qui serait fait |
| Quand vous voulez (écran) | **déposer les exports** Aramex / AFEX / Drest Delivery / Big Boss pour apprendre les codes des colis |

Colis créés depuis le BO : l'application lit leur n° toute seule (aucun export).
Colis créés directement chez le transporteur (portail, fichier en masse, Drest Delivery) : déposer l'export ;
ensuite l'application suit chaque colis seule jusqu'à « livré » ou « retour ».

## Mise en ligne (≈ 30 min)

### 1. Code sur GitHub
Le code est dans le dépôt privé `drest-sarl/application-transporteur-drest` (branche `main`). Chaque modification poussée sur `main` est redéployée automatiquement par Vercel.

### 2. Créer le projet Vercel
1. vercel.com → **Add New… → Project** → importer `drest-synchro-statuts` → **Deploy** (le 1er déploiement peut afficher une erreur : normal, les variables manquent).
2. Projet → **Storage** → **Connect Database** → la base **Neon** créée → **Connect** (ajoute `DATABASE_URL` automatiquement).

### 3. Saisir les variables (Projet → Settings → Environment Variables)
| Nom | Valeur |
|---|---|
| `ADMIN_PASSWORD` | mot de passe de l'écran (choisi par vous) |
| `CRON_SECRET` | longue chaîne au hasard (ex. 40 caractères), sert aux appels automatiques |
| `BO_URL` | `https://bo.drest.tn` |
| `BO_LOGIN` / `BO_PASSWORD` | **compte de service** du back-office (droit : lire les commandes + forcer un statut) |
| `BIGBOSS_UTILISATEUR` / `BIGBOSS_PASS` | login_exp du profil Big Boss / **token API** (UUID) |
| `BIGBOSS_WEBHOOK_SECRET` | secret `whsec_…` donné par Big Boss à l'étape 5 |
| `AFEX_API_KEY` | clé API AFEX |
| `ARAMEX_USERNAME` / `ARAMEX_PASSWORD` / `ARAMEX_ACCOUNT_PIN` | accès API Aramex |
| `ARAMEX_ACCOUNT_NUMBER` | `72655188` |
| `ARAMEX_ACCOUNT_ENTITY` / `ARAMEX_COUNTRY_CODE` | `TUN` / `TN` |

Puis **Deployments → … → Redeploy**. Ouvrir `https://<projet>.vercel.app` → mot de passe → l'écran s'affiche en **SIMULATION**.

### 4. Les appels automatiques (cron-job.org)
Créer 2 tâches (**Create cronjob**) :
| Titre | URL | Fréquence |
|---|---|---|
| Drest collecte | `https://<projet>.vercel.app/api/sync/collecte?cle=<CRON_SECRET>` | toutes les 10 minutes |
| Drest envoi | `https://<projet>.vercel.app/api/sync/envoi?cle=<CRON_SECRET>` | toutes les minutes |
Dans **Advanced** : *Request timeout* au maximum (60 s si proposé). Activer la notification par e-mail en cas d'échec.

### 5. Brancher le webhook Big Boss
Dans le profil Big Boss → **Webhook** (mode administrateur) : URL `https://<projet>.vercel.app/api/webhooks/bigboss`, tous les événements.
Big Boss affiche une **seule fois** le secret `whsec_…` : le copier dans la variable `BIGBOSS_WEBHOOK_SECRET`, puis **Redeploy**.
Bouton « Tester » de Big Boss : l'application répond `ok`.

### 6. Premier remplissage
1. Écran → **Synchroniser maintenant** 2 ou 3 fois (lecture de toute la liste des commandes du BO sur 45 jours).
2. **Déposer les exports** du jour : rapport Aramex, export AFEX, export Drest Delivery, export Big Boss.
3. La **file d'attente** montre ce qui serait changé ; le **journal** se remplit en « simulation ».

### 7. Rodage puis passage en réel
- 1 à 2 jours en simulation : comparer la file avec les mises à jour habituelles.
- Puis **Passer en réel** : les changements simulés deviennent réels et partent au rythme de 700 / heure.
- **Pause** arrête tout envoi immédiatement. **Annuler** (journal) remet l'ancien statut. **Retirer** enlève une ligne de la file.

## Règles appliquées
- Big Boss : 5 Livré → Livrée ; 6 Retour expéditeur → Retour expéditeur ; 0-4 → Livraison en cours. Échanges exclus.
- AFEX : delivered → Livrée ; returned / canceled / *_rto / *_return → Retour ; autres en cours ; « retourné mais livré » → alerte ; exception → alerte (perdu).
- Aramex : SH005 Delivered, SH239 Shipment charges paid, Paid → Livrée ; Returned / Refused → Retour ; autres en cours ; code inconnu → alerte, rien changé.
- Drest Delivery : Livré / Payé / PAID_RECEIVED → Livrée ; **Annulé → Retour expéditeur** ; En attente ignoré s'il existe un autre colis.
- Plusieurs colis : un colis **livré** l'emporte ; sinon le plus récent. Double expédition → alerte.
- Statuts finaux du BO jamais touchés, sauf « retour » → « livrée » quand une double expédition a été livrée. Commande annulée → jamais touchée.
- Juste avant chaque changement, le statut est relu dans le BO ; le BO refuse si la commande a bougé (statut attendu).

## En cas de problème
- Écran « DATABASE_URL manquante » : relier la base Neon (étape 2) puis Redeploy.
- Transporteur « accès manquants » : variable absente ou mal écrite, puis Redeploy.
- Alerte « API Big Boss / AFEX / Aramex / back-office » : accès refusé ou service indisponible ; les autres transporteurs continuent.
