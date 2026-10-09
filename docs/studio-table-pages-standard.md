# Studio Table Pages Standard

Ce document decrit l'organisation de reference a suivre pour toutes les pages
Studio qui affichent une collection sous forme de tableau, liste dense, file,
historique ou registre. La base visuelle et comportementale est la page
`/workflows` dans `apps/studio/src/routes/workflows.tsx`.

## Objectif

Les pages de donnees doivent ressembler a un outil operationnel: compactes,
lisibles, rapides a scanner, et coherentes entre elles. La page workflows sert
de reference parce qu'elle combine:

- une action primaire visible dans le header;
- une barre de filtres compacte;
- un compteur de resultats;
- une liste dense avec colonnes stables;
- des etats loading, erreur et vide;
- un comportement responsive qui masque les colonnes secondaires avant de
  casser la mise en page.

## Structure generale

Chaque page de collection doit suivre cet ordre:

1. `AppShell`
   - Definit le padding de contenu.
   - Porte les actions globales de la page dans `headerActions`.

2. Conteneur principal
   - Utiliser `grid gap-3` pour les pages denses.
   - Eviter les sections decoratives ou les cartes imbriquees.

3. Barre de filtres
   - Recherche principale en premier.
   - Selects de filtres ensuite.
   - Compteur `visible/total`.
   - Bouton iconique de filtres avances si necessaire.

4. Liste ou tableau
   - Une bordure externe.
   - Des lignes separees par `divide-y`.
   - Des colonnes fixes ou semi-fixes.
   - Une premiere colonne flexible pour l'identite de l'objet.

5. Modales ou panneaux annexes
   - Creation, edition rapide, confirmation ou actions avancees.
   - Ces elements restent hors du flux principal de la liste.

## Header

Le header doit contenir l'action primaire de la page. Pour workflows, c'est
`Create workflow`.

Regles:

- placer l'action principale dans `AppShell.headerActions`;
- placer tous les boutons d'actions globales de la page dans le header, a
  droite, via `AppShell.headerActions`;
- ne pas rendre de boutons d'actions globales dans le contenu de page, dans le
  `PageHeader`, ni au-dessus de la barre de filtres;
- utiliser un `Button` `size="sm"`;
- associer une icone lucide explicite a l'action;
- desactiver le bouton pendant une mutation;
- eviter de repeter le titre de page dans le contenu si la navigation le rend
  deja clair.

Exemple de reference:

```tsx
<AppShell
  contentClassName="px-3 py-4"
  headerActions={
    <Button size="sm" type="button" variant="secondary">
      <Plus className="h-4 w-4" />
      Create workflow
    </Button>
  }
>
  ...
</AppShell>
```

## Barre de filtres

La barre de filtres doit rester sur une seule ligne quand l'espace le permet et
se replier proprement sur mobile.

Ordre recommande:

1. Recherche texte.
2. Filtres par statut ou type.
3. Filtres temporels ou metier.
4. Compteur de resultats.
5. Bouton de filtres avances.

Regles:

- wrapper: `flex flex-wrap items-center gap-2`;
- recherche: `relative min-w-64 flex-1`;
- input: hauteur `h-10`, bordure, fond `bg-background`, focus ring;
- select: hauteur `h-10`, largeur minimale stable;
- compteur: hauteur `h-10`, bordure, fond, texte secondaire + valeur forte;
- bouton avance: `size="icon"` avec `aria-label`.

Le filtre doit etre local si la collection est deja chargee cote client. Si le
volume ou la source impose un filtrage serveur, conserver la meme forme visuelle
mais synchroniser les filtres avec les query params.

## Liste et tableau

La page workflows utilise une liste dense qui fonctionne comme un tableau. Les
autres pages peuvent utiliser un vrai `<table>` si les donnees le demandent,
mais elles doivent garder les memes principes.

Conteneur:

```tsx
<div className="overflow-hidden rounded-surface border bg-card">
  <div className="divide-y">
    {rows.map((row) => (
      <Row key={row.id} row={row} />
    ))}
  </div>
</div>
```

Ligne:

- la ligne entiere peut etre cliquable si l'action principale est d'ouvrir le
  detail;
- premiere colonne: nom, identifiant ou libelle principal;
- sous-texte optionnel: description, provenance ou metadata courte;
- colonnes secondaires: statut, compteurs, date, etat active/desactive;
- derniere colonne: icone d'action ou menu;
- hauteur minimale stable, par exemple `min-h-14`;
- utiliser `truncate` sur tous les champs qui peuvent depasser.

Grille de reference:

```tsx
className="
  grid min-h-14
  grid-cols-[minmax(220px,1fr)_120px_100px_100px_140px_100px_32px]
  items-center gap-4 px-3 py-3 text-sm transition-colors hover:bg-secondary/60
  max-xl:grid-cols-[minmax(220px,1fr)_120px_100px_120px_32px]
  max-lg:grid-cols-[minmax(0,1fr)_100px_32px]
"
```

Pour un vrai tableau:

- garder une premiere colonne flexible et lisible;
- eviter trop de colonnes visibles sur mobile;
- mettre les actions a droite;
- utiliser `overflow-x-auto` seulement quand les colonnes ne peuvent pas etre
  simplifiees;
- preferer une densite de ligne proche de workflows.

## Responsive

Les colonnes doivent disparaitre par priorite, pas provoquer un scroll
horizontal immediat.

Priorite d'affichage:

1. Identite principale.
2. Statut ou information critique.
3. Action/menu.
4. Compteurs.
5. Date.
6. Metadata secondaire.

Classes de reference:

- `max-xl:hidden` pour les champs utiles mais non critiques;
- `max-lg:hidden` pour les champs secondaires;
- `minmax(0,1fr)` sur mobile pour permettre au texte de tronquer;
- `truncate` dans chaque cellule textuelle.

## Statuts

Les statuts doivent etre courts, scannables et coherents.

Pattern workflows:

- un point colore avec `Circle`;
- label en title case;
- vert pour un etat termine avec succes;
- gris pour jamais execute ou inactif;
- ambre pour les etats en attente, en cours ou necessitant attention.

Pour les pages plus critiques, ajouter une couleur destructive uniquement pour
les erreurs ou echecs reels.

## Etats de chargement

Chaque page de donnees doit gerer explicitement:

- erreur: bloc border + fond destructif leger;
- loading: bloc border + texte muted;
- vide: bloc border dashed + texte centre;
- liste chargee: conteneur border + lignes separees.

Les messages doivent etre courts et specifiques:

- `Loading workflows...`
- `No workflows found.`
- `No runs found.`
- `No queue items found.`

## Creation

Quand la creation est simple, l'action primaire ouvre une modale. La modale
doit:

- reinitialiser son etat a l'ouverture;
- valider le minimum avant submit;
- afficher les erreurs de mutation dans un bloc destructif;
- proposer `Cancel` et l'action primaire;
- desactiver l'action pendant la mutation;
- rediriger vers le detail de l'objet cree quand un identifiant est retourne.

Pour un choix de template ou de type, utiliser des boutons cartes simples avec:

- icone;
- titre court;
- description concise;
- etat selectionne via bordure/fond.

## Donnees et mutations

Pattern recommande avec TanStack Query:

- `useQuery` avec une `queryKey` egale a l'endpoint;
- `data?.collectionKey ?? []` comme valeur par defaut;
- filtres derives dans un `useMemo`;
- `useMutation` pour les actions;
- `queryClient.invalidateQueries` sur succes;
- navigation vers le detail quand l'action cree une ressource.

Exemple:

```tsx
const { data, isPending, error } = useQuery({
  queryKey: ["/studio/workflows"],
  queryFn: () => apiGet<Payload>("/studio/workflows"),
});

const rows = data?.workflows ?? [];
```

## A appliquer aux pages existantes

Les pages qui utilisent encore `ResourcePage` peuvent evoluer vers ce standard
progressivement. Priorite:

- `/runs`: historique dense avec filtres statut/date et actions cancel/retry;
- `/queue`: file operationnelle avec statut, age, tentative et worker;
- `/transfers`: liste dense avec enabled, dernier run, destination/source et
  actions;
- `/schedules`: liste dense avec actif, prochaine execution et dernier resultat;
- `/credentials`: liste dense avec provider, usage et statut;
- `/dead-letter`: liste dense avec erreur, retry count, date et action retry;
- pages MCP: activite, tokens, capabilities et connexions.

## Checklist d'une nouvelle page tableau

- [ ] La page est dans `AppShell`.
- [ ] L'action primaire est dans le header.
- [ ] Les filtres sont compacts et se replient correctement.
- [ ] Le compteur affiche `visible/total`.
- [ ] La premiere colonne identifie clairement l'objet.
- [ ] Les cellules longues utilisent `truncate`.
- [ ] Les colonnes secondaires disparaissent sur `max-xl` ou `max-lg`.
- [ ] Les statuts utilisent un rendu court et coherent.
- [ ] Les etats loading, error et empty sont explicites.
- [ ] Les mutations invalident la bonne query.
- [ ] La creation redirige vers le detail quand c'est pertinent.
