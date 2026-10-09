# Architecture Desktop Et Execution Hybride

Statut: decision d'architecture cible.

## Decision

Beam Transfer Studio doit pouvoir fonctionner comme une application Electron
sans abandonner le modele distribue actuel.

Electron remplace le mode de deploiement local visible par l'utilisateur, mais
ne remplace pas l'abstraction de worker:

- Electron supervise les processus locaux et affiche le Studio;
- un worker logique represente une machine ou un environnement d'execution;
- chaque action peut etre executee dans un subprocess isole;
- l'orchestrateur conserve la responsabilite du placement, des retries et de
  l'etat durable des workflows.

Le meme workflow doit pouvoir utiliser des workers locaux et distants.

## Modes De Deploiement

### Local

L'application Electron lance un runtime local et un ou plusieurs slots
d'execution. Les actions s'executent dans des subprocess sur la machine de
l'utilisateur.

Ce mode est adapte aux fichiers locaux, aux credentials du poste et aux
services accessibles uniquement depuis le reseau local.

### Hybride

Le control plane est deploye sur un VPS tandis qu'Electron lance un worker sur
le poste de l'utilisateur. D'autres workers peuvent fonctionner sur le VPS ou
sur d'autres machines.

Le worker desktop initie une connexion sortante securisee vers le control
plane. Il ne doit pas etre necessaire d'exposer directement le poste de
l'utilisateur sur Internet.

### Distant

Le Studio, PostgreSQL, NATS, l'orchestrateur et les workers sont deployes sur
un ou plusieurs serveurs. Electron peut alors etre un client optionnel du
Studio distant.

## Responsabilites

### Control Plane

Le control plane reste la source de verite pour:

- les definitions et versions de workflows;
- la planification;
- l'etat durable des runs et des taches;
- le placement des taches;
- les retries, timeouts et dead letters;
- l'historique, les logs et l'observabilite.

### Worker

Un worker:

- declare son identite, ses capabilities et sa reachability;
- emet des heartbeats;
- reclame uniquement les taches qui lui sont assignees;
- applique les limites de concurrence;
- supervise les subprocess d'actions;
- publie les resultats et les artefacts;
- gere le drain, la cancellation et l'arret propre.

Un subprocess n'est donc pas un remplacement du worker. Il constitue la
frontiere d'isolation d'une execution sous la supervision du worker.

### Electron

Le main process Electron agit comme superviseur local. Il peut demarrer,
surveiller et arreter l'API locale, le runtime et les workers locaux.

Le renderer ne doit jamais lancer directement une action ni recevoir un acces
Node.js general. Toute operation privilegiee passe par une API locale ou une
surface IPC minimale exposee par le preload.

## Placement

Le concept actuel de `local-workers` doit evoluer vers des pools d'execution et
des contraintes de placement.

Exemple de preference explicite:

```json
{
  "execution": {
    "pool": "desktop-local"
  }
}
```

Exemple de placement par capabilities:

```json
{
  "execution": {
    "requires": ["filesystem:local", "network:private"],
    "prefer": ["same-host-as-input"]
  }
}
```

L'orchestrateur choisit un worker compatible selon:

- les capabilities requises par l'action;
- la charge et la concurrence disponible;
- la localisation des donnees;
- l'acces aux endpoints reseau;
- la disponibilite des credentials;
- le pool ou le worker demande explicitement;
- la politique de fallback du workflow.

Un workflow peut ainsi melanger des etapes locales et distantes. Par exemple,
une premiere etape lit un fichier sur le poste, une seconde effectue un
traitement sur un VPS, puis une derniere ecrit le resultat sur un stockage
distant.

## Donnees Et Credentials

Un worker distant ne peut pas acceder implicitement aux fichiers ou secrets
d'un poste local.

Le passage d'une etape locale a une etape distante exige un artefact
transferable:

- une URL temporaire signee exposee par le worker;
- un acheminement via le control plane;
- ou un upload vers un object storage.

Les credentials restent attaches au scope et au worker qui peut les utiliser.
Le control plane ne doit pas transmettre un secret local a un worker distant
sans autorisation explicite.

## Disponibilite

Lorsqu'un worker desktop est hors ligne, la politique du workflow determine si
la tache:

- attend le retour du worker;
- bascule vers un autre worker compatible;
- ou echoue apres un timeout.

Les subprocess en cours doivent etre consideres interrompus si Electron ou le
worker s'arrete brutalement. L'etat durable du control plane permet alors de
reprendre ou retenter la tache.

## Securite

Le mode hybride exige au minimum:

- une authentification forte du worker;
- des tokens courts et scopes ou une identite mTLS;
- des packages d'actions signes et verifies;
- une politique explicite de permissions;
- une isolation par subprocess avec timeout et cancellation;
- aucune execution arbitraire provenant directement du renderer;
- des journaux d'audit pour le placement et l'execution.

Un subprocess Node.js limite les effets d'un crash mais ne constitue pas a lui
seul une sandbox de securite forte. Les actions non fiables peuvent necessiter
une isolation supplementaire selon la plateforme.

## Strategie D'Implementation

### Phase 1: Electron Comme Superviseur

- emballer le Studio dans Electron;
- lancer l'API, l'orchestrateur et un worker local comme processus enfants;
- conserver PostgreSQL et NATS;
- reutiliser le runtime de subprocess existant;
- ajouter le cycle de vie, les logs et le redemarrage des processus.

Cette phase minimise les divergences avec le deploiement serveur.

### Phase 2: Profil Desktop Autonome

- introduire une queue locale durable;
- utiliser SQLite pour le profil standalone si necessaire;
- remplacer NATS local par une interface de notification in-process ou IPC;
- conserver les memes contrats de tache et de worker.

### Phase 3: Pools Hybrides

- introduire les pools et contraintes de placement;
- permettre l'enregistrement securise de workers desktop sur un control plane
  distant;
- ajouter les politiques offline et fallback;
- finaliser le transport d'artefacts entre workers locaux et distants.

## Consequence Principale

Le produit conserve une seule architecture conceptuelle:

```text
Studio -> control plane -> worker logique -> subprocess d'action
```

Seul le lieu d'execution change. Cette separation permet de proposer une
experience desktop simple tout en gardant la scalabilite d'un deploiement VPS
ou multi-machines.
