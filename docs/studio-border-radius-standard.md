# Studio Border Radius Standard

Statut : règle de design appliquée à l'interface Studio.

## Objectif

Harmoniser les arrondis selon le rôle et la taille des composants, en gardant
une interface opérationnelle et compacte. Un rayon de 12 px convient aux
surfaces autonomes, mais ne doit pas être appliqué à tous les éléments.

## Échelle de référence

| Usage                                                                          | Rayon cible      | Token CSS                  | Classe Tailwind           |
| ------------------------------------------------------------------------------ | ---------------- | -------------------------- | ------------------------- |
| Cartes, nœuds de workflow standards, modales, conteneurs autonomes de tableaux | 12 px par défaut | `--radius-surface`         | `rounded-surface`         |
| Boutons, champs, selects, menus et popovers standards                          | 8 px             | `--radius-control`         | `rounded-control`         |
| Variantes compactes de contrôles, éléments internes de menus                   | 6 px             | `--radius-control-compact` | `rounded-control-compact` |
| Petits badges et éléments compacts non circulaires                             | 4 px             | `--radius-badge`           | `rounded-badge`           |
| Séparations internes, lignes de tableaux, panneaux collés aux bords            | 0 px             | Aucun nécessaire           | `rounded-none`            |
| Avatars, pastilles, connecteurs circulaires, pilules intentionnelles           | Complet          | Aucun nécessaire           | `rounded-full`            |

Ces tokens et classes sémantiques sont disponibles dans le thème Studio.
Le rayon standard des contrôles est 8 px ; 6 px est réservé à une variante
compacte explicite du composant. Un même composant doit garder le même rayon
d'une page à l'autre.

## Règle de concentricité

Pour deux surfaces imbriquées, leurs coins doivent rester concentriques :

```text
rayon extérieur = rayon intérieur + distance entre les deux surfaces
```

Cette formule est prioritaire sur l'échelle de référence. Le rayon de surface
par défaut est donc calculé, et non défini indépendamment : un contrôle intérieur
à 8 px séparé de 4 px de sa surface extérieure donne un rayon extérieur de
12 px.

Exemples :

- rayon intérieur 8 px + distance 4 px = rayon extérieur 12 px ;
- rayon intérieur 8 px + distance 8 px = rayon extérieur 16 px ;
- rayon intérieur 4 px + distance 4 px = rayon extérieur 8 px.

`rounded-surface` convient au cas par défaut 8 px + 4 px et aux surfaces sans
coin intérieur à aligner. Quand la distance réelle ou le rayon intérieur est
différent, le composant doit calculer son rayon extérieur avec la formule et
porter cette décision dans son abstraction partagée. Il ne faut pas forcer
12 px sur une surface imbriquée si ses deux termes ne produisent pas 12 px.

La distance se mesure entre les contours des deux surfaces au niveau du coin.
Si les surfaces se touchent, la distance vaut 0 et les rayons partagent la même
valeur. Pour un groupe jointif, seuls les coins qui appartiennent au contour
extérieur reçoivent cet arrondi.

## Règles d'application

- Appliquer d'abord la règle de concentricité, puis choisir le rayon selon le
  rôle du composant quand aucune surface intérieure ne contraint le coin.
- Arrondir le contour extérieur d'une surface autonome ; garder les
  séparations et les lignes internes à 0 px. Pour un groupe de contrôles
  jointifs, arrondir seulement les coins extérieurs.
- Conserver les panneaux structurels collés aux bords à 0 px. Une modale
  flottante utilise 12 px ; un panneau latéral ancré suit la règle structurelle.
- Conserver les nœuds endpoint/resource de workflow en pilule. Les nœuds
  d'action standards, composites et cartes de contrôle utilisent 12 px.
- Conserver les colonnes de statut du dashboard à 0 px : elles structurent le
  tableau de suivi et utilisent explicitement `rounded-none`.
- Garder le même rayon en thèmes clair et sombre, au survol, au focus,
  à la sélection et dans les états désactivés ou en erreur.
- Utiliser les tokens partagés. Toute valeur hors échelle doit correspondre à
  un besoin identifié et être documentée ; éviter les valeurs arbitraires
  répétées dans les composants.
- Vérifier les fonds imbriqués, bordures et focus rings. Ne pas ajouter
  systématiquement `overflow-hidden` : cela peut couper les menus ou les
  connecteurs de workflow qui débordent volontairement de leur carte.

## Implémentation et points d'entrée

- [Configuration Tailwind](../apps/studio/tailwind.config.ts) : expose les
  classes sémantiques. Les alias Tailwind conventionnels restent disponibles
  pour le code tiers et ancien, mais le code produit utilise les noms par rôle.
- [Styles globaux](../apps/studio/src/styles.css) : centralise les valeurs.
  `--radius-surface` est calculé à partir de `--radius-control` et de
  `--radius-surface-inset`. Le token de compatibilité `--radius` pointe vers le
  contrôle à 8 px.
- [Carte de workflow](../apps/studio/src/features/workflows/workflow-node-card.tsx) :
  utilise 12 px pour la carte, 8 px pour le conteneur d'icône et 4 px pour les
  badges d'état.
- [Nœuds de workflow](../apps/studio/src/features/workflows/workflow-step-node.tsx) :
  les endpoints/resource utilisent `rounded-full`.
- [Standard des pages de tableaux](studio-table-pages-standard.md) :
  applique cette règle aux contours et contrôles sans changer ses principes
  de densité et de structure.

## Méthode pour les évolutions

1. Identifier le rôle du nouveau composant dans l'échelle avant de choisir sa
   classe. Ne pas déduire le rayon d'une dimension Tailwind comme `md` ou `lg`.
2. Réutiliser une classe sémantique existante. Si aucun rôle ne convient,
   documenter le besoin avant d'ajouter un token ou une valeur.
3. Pour une nouvelle surface composée, appliquer l'arrondi au contour externe
   avec la formule de concentricité et garder ses séparations internes carrées.
4. Vérifier les états clair/sombre, focus, sélection, erreur et les petits
   écrans. La revue visuelle finale appartient à l'utilisateur.

## Critères d'acceptation

- Les composants suivent l'échelle 0 / 4 / 6 / 8 / 12 px / complet.
- Les valeurs partagées sont centralisées et les classes ont un rôle clair.
- Les surfaces imbriquées respectent `rayon extérieur = rayon intérieur +
distance`, y compris lorsque le résultat sort de l'échelle par défaut.
- Les surfaces autonomes ont un contour cohérent et leurs lignes internes
  restent jointives, sans arrondi parasite.
- Les endpoints/resource restent en pilule ; les connecteurs de workflow,
  menus et focus rings ne sont pas coupés.
- Les valeurs hors échelle sont absentes ou documentées et les exemples sont à
  jour.
- La revue visuelle utilisateur valide les pages et états représentatifs.
