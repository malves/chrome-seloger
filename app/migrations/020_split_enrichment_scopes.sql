-- Refonte des portées de cache d'enrichissement (commune / département / annonce).
--
-- Avant : `immo-data` était mis en cache par annonce (JSON complet ville+dépt),
-- et les providers communaux écrivaient une ligne « statut seul » (data NULL)
-- dans `listing_enrichments`. Désormais `immo-data` vit en portée communale
-- (`commune_data`) et son volet départemental en portée départementale ; les
-- providers communaux/départementaux n'écrivent plus de ligne par annonce.
--
-- On supprime donc ces lignes devenues obsolètes : elles seront recalculées
-- dans la bonne portée au prochain enrichissement (réimport, actualisation du
-- territoire ou « Réessayer »). Les caches `commune_data` (commune, délinquance)
-- restent valides et ne sont pas touchés.
DELETE FROM listing_enrichments
WHERE provider IN ('immo-data', 'commune', 'delinquance');
