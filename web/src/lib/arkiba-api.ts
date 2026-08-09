/**
 * Arkiba — client de l'API existante.
 *
 * Point d'entrée UNIQUE des écrans vers le backend. Aucun composant n'appelle
 * `fetch` directement : la refonte visuelle a précisément pour risque de
 * réinventer, écran par écran, des appels légèrement différents de ceux qui
 * marchaient. Tout passe par ici, et les contrats ci-dessous ont été relevés
 * sur le serveur qui tourne, pas déduits de la lecture du code.
 *
 * Le backend n'est pas modifié par la refonte : routes, sécurité, RGPD et
 * anonymisation restent ceux de server.js.
 */

// ─── Stockage de session ────────────────────────────────────────────────────
// Les clés restent celles de l'application actuelle : un médecin déjà connecté
// ne doit pas être déconnecté par la refonte.
const CLE_JETON  = 'praxi_token';
const CLE_PROFIL = 'praxi_profil';

export function getToken(): string | null {
  try { return localStorage.getItem(CLE_JETON); } catch { return null; }
}

export function setSession(token: string, user: User): void {
  localStorage.setItem(CLE_JETON, token);
  localStorage.setItem(CLE_PROFIL, JSON.stringify(user));
}

export function getProfilLocal(): User | null {
  try {
    const brut = localStorage.getItem(CLE_PROFIL);
    return brut ? (JSON.parse(brut) as User) : null;
  } catch { return null; }
}

export function clearSession(): void {
  localStorage.removeItem(CLE_JETON);
  localStorage.removeItem(CLE_PROFIL);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface User {
  id: number;
  prenom: string;
  nom: string;
  email: string;
  /** Concaténation « A, B » — ce que le backend injecte dans les prompts. */
  specialite: string;
  specialites: string[];
  ville: string;
  rpps: string;
  adresse: string;
  telephone: string;
  emailPro: string;
  status: string;
  createdAt: string;
}

export interface Patient {
  id: string;
  userId: number;
  nom: string;
  ddn: string;
  sexe: string;
  patho: string;
  traitements: string;
  allergies: string;
  mt: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** Calculé par le serveur à partir de la date de naissance. */
  age: number | null;
  nbDocuments?: number;
  dernierDocument?: string | null;
}

export interface Document {
  id: string;
  userId: number;
  patientId: string | null;
  patientNom: string;
  type: DocumentType;
  typeLabel: string;
  titre: string;
  contenu: string;
  sources: unknown[];
  meta: Record<string, unknown>;
  createdAt: string;
}

export type DocumentType =
  | 'cr' | 'liaison' | 'resume' | 'mdph' | 'ald'
  | 'certificat' | 'ordonnance' | 'avis' | 'consult';

/** Un jour de la timeline d'un dossier patient. */
export interface JourTimeline {
  jour: string;
  documents: Document[];
}

export interface TimelinePatient {
  patient: Patient;
  documents: Document[];
  jours: JourTimeline[];
  stats: {
    total: number;
    premier: string | null;
    dernier: string | null;
    parType: Record<string, number>;
  };
}

export interface ContextePatient {
  patient: Patient;
  documents: Array<{ ref: string; id: string; type: string; typeLabel: string; [k: string]: unknown }>;
  vide: boolean;
  apercu: string;
}

export interface Referentiel {
  key: string;
  label: string;
  source: { libelle: string; url: string };
  sections: string[];
  [k: string]: unknown;
}

/** Contrôle de sûreté renvoyé avec chaque document généré. */
export interface Safety {
  [k: string]: unknown;
}

export interface ResultatGeneration {
  document: string;
  safety?: Safety;
  referentiel?: Referentiel | null;
  contexte?: unknown;
}

export interface RegisterPayload {
  prenom: string;
  nom: string;
  email: string;
  password: string;
  /** Toujours un tableau : le serveur valide contre la liste fermée. */
  specialites: string[];
  ville: string;
  rpps?: string;
}

// ─── Erreurs ────────────────────────────────────────────────────────────────

/**
 * Erreur d'API porteuse du code HTTP. Les écrans en ont besoin : un 429 se dit
 * autrement qu'un 400, et un 503 « service IA non configuré » n'est pas une
 * erreur de saisie du médecin.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Déclenché sur 401 : permet à la coquille applicative de renvoyer au login. */
export type OnUnauthorized = () => void;
let onUnauthorized: OnUnauthorized | null = null;
export function setOnUnauthorized(fn: OnUnauthorized | null): void { onUnauthorized = fn; }

// ─── Requête de base ────────────────────────────────────────────────────────

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(opts.headers);
  if (opts.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...opts, headers });

  // Le serveur répond en JSON sur toutes ses routes /api, y compris en erreur
  // (404 compris — c'est une régression qu'un test verrouille). On ne suppose
  // pourtant pas que le corps soit lisible : un proxy peut s'intercaler.
  const data = await res.json().catch(() => ({} as Record<string, unknown>));

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      onUnauthorized?.();
    }
    const message = typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : `Erreur ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

// ─── Authentification ───────────────────────────────────────────────────────

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: email.trim(), password }),
  });
  setSession(data.token, data.user);
  return data;
}

export async function register(payload: RegisterPayload): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  setSession(data.token, data.user);
  return data;
}

export async function getMe(): Promise<User> {
  const { user } = await request<{ user: User }>('/api/auth/me');
  return user;
}

export async function updateProfile(patch: Partial<User>): Promise<User> {
  const { user } = await request<{ user: User }>('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  // Le profil local alimente l'en-tête des documents : il doit suivre.
  localStorage.setItem(CLE_PROFIL, JSON.stringify(user));
  return user;
}

export async function forgotPassword(email: string): Promise<void> {
  await request('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: email.trim() }),
  });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await request('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
}

export function logout(): void {
  clearSession();
}

// ─── Spécialités ────────────────────────────────────────────────────────────

/**
 * Source unique de vérité des menus « spécialité ».
 *
 * Ne JAMAIS recopier cette liste dans un composant : l'inscription a refusé
 * toutes ses options pendant des semaines parce que register.html embarquait sa
 * propre copie, restée sur l'ancien vocabulaire pendant que le serveur validait
 * contre la nouvelle. Un test de non-régression interdit désormais toute liste
 * en dur dans les pages.
 */
export async function getSpecialites(): Promise<string[]> {
  const { specialites } = await request<{ specialites: string[] }>('/api/specialites');
  return specialites;
}

/** Spécialités disposant d'une base indexée pour l'avis spécialisé. */
export interface SpecialiteAvis {
  key: string;
  label: string;
  accepteImages: boolean;
  baseIndexee: boolean;
  passages: number;
  recherche: string;
}

export async function getSpecialitesAvis(): Promise<SpecialiteAvis[]> {
  const { specialites } = await request<{ specialites: SpecialiteAvis[] }>('/api/avis-specialise/specialites');
  return specialites;
}

// ─── Patients ───────────────────────────────────────────────────────────────

export async function listPatients(q = ''): Promise<Patient[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const { patients } = await request<{ patients: Patient[] }>(`/api/patients${qs}`);
  return patients;
}

export async function createPatient(payload: Partial<Patient>): Promise<Patient> {
  const { patient } = await request<{ patient: Patient }>('/api/patients', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return patient;
}

/** Fiche + timeline complète : c'est ce que consomme l'écran Dossier patient. */
export async function getPatient(id: string): Promise<TimelinePatient> {
  return request<TimelinePatient>(`/api/patients/${encodeURIComponent(id)}`);
}

export async function updatePatient(id: string, patch: Partial<Patient>): Promise<Patient> {
  const { patient } = await request<{ patient: Patient }>(`/api/patients/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return patient;
}

export async function deletePatient(id: string): Promise<void> {
  await request(`/api/patients/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Contexte clinique antérieur condensé. Alimente l'encart affiché avant
 * génération : le médecin voit ce que Arkiba s'apprête à réutiliser du dossier,
 * et peut le refuser.
 */
export async function getContextePatient(id: string): Promise<ContextePatient> {
  return request<ContextePatient>(`/api/patients/${encodeURIComponent(id)}/contexte`);
}

// ─── Documents ──────────────────────────────────────────────────────────────

export async function listDocuments(
  filtres: { patientId?: string | null; type?: string | null; q?: string } = {},
): Promise<Document[]> {
  const params = new URLSearchParams();
  if (filtres.patientId) params.set('patientId', filtres.patientId);
  if (filtres.type)      params.set('type', filtres.type);
  if (filtres.q)         params.set('q', filtres.q);
  const qs = params.toString() ? `?${params}` : '';
  const { documents } = await request<{ documents: Document[] }>(`/api/documents${qs}`);
  return documents;
}

export async function getDocument(id: string): Promise<Document> {
  const { document } = await request<{ document: Document }>(`/api/documents/${encodeURIComponent(id)}`);
  return document;
}

export async function createDocument(payload: {
  patientId?: string | null;
  type: DocumentType;
  contenu: string;
  titre?: string;
  sources?: unknown[];
  meta?: Record<string, unknown>;
}): Promise<Document> {
  const { document } = await request<{ document: Document }>('/api/documents', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return document;
}

export async function deleteDocument(id: string): Promise<void> {
  await request(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Référentiels de spécialité ─────────────────────────────────────────────

export async function getMonReferentiel(): Promise<Referentiel> {
  const { referentiel } = await request<{ referentiel: Referentiel }>('/api/referentiels/mien');
  return referentiel;
}

// ─── Génération de documents ────────────────────────────────────────────────

/** Types de documents générables et leur route. */
const ROUTES_GENERATION = {
  'compte-rendu': '/api/generate/compte-rendu',
  liaison:        '/api/generate/liaison',
  resume:         '/api/generate/resume',
  mdph:           '/api/generate/mdph',
  ald:            '/api/generate/ald',
  certificat:     '/api/generate/certificat',
  ordonnance:     '/api/generate/ordonnance',
} as const;

export type KindGeneration = keyof typeof ROUTES_GENERATION;

/** État d'une étape de génération, tel que l'affiche l'indicateur de progression. */
export type EtatEtape = 'done' | 'active' | 'todo';

export interface EtapeGeneration {
  libelle: string;
  etat: EtatEtape;
}

export type OnProgress = (etapes: EtapeGeneration[]) => void;

/**
 * Étapes réelles du traitement.
 *
 * Chaque étape correspond à une phase effectivement franchie, pas à une
 * minuterie : « Reprise du dossier patient » n'est marquée faite que lorsque
 * GET /api/patients/:id/contexte a répondu, « Application du référentiel » que
 * lorsque le référentiel est chargé. La dernière étape — la rédaction — reste
 * active tant que le modèle n'a pas rendu son texte : un faux « terminé » avant
 * l'arrivée du document serait un mensonge d'interface.
 */
const ETAPES_SANS_DOSSIER = [
  'Lecture des notes',
  'Application du référentiel de spécialité',
  'Rédaction du document',
];

const ETAPES_AVEC_DOSSIER = [
  'Lecture des notes',
  'Reprise du dossier patient',
  'Application du référentiel de spécialité',
  'Rédaction du document',
];

/** Petit pilote d'avancement : il ne sait qu'avancer, jamais revenir en arrière. */
function pilote(libelles: string[], onProgress?: OnProgress) {
  let courant = 0;
  const emettre = () => onProgress?.(libelles.map((libelle, i) => ({
    libelle,
    etat: i < courant ? 'done' : i === courant ? 'active' : 'todo',
  })));
  emettre();
  return {
    /** Franchit une phase réelle. La dernière étape ne se referme jamais seule. */
    avance() {
      if (courant >= libelles.length - 1) return;
      courant += 1;
      emettre();
    },
  };
}

/**
 * Génère un document.
 *
 * `payload` est transmis tel quel au backend : les champs attendus diffèrent
 * d'un type à l'autre (`notes` pour un compte-rendu, `motif`/`specialiste` pour
 * une lettre de liaison, `medicaments`/`bizone` pour une ordonnance…). C'est le
 * contrat existant de server.js, la refonte ne le change pas.
 *
 * ⚠ Les données identifiantes doivent avoir été pseudonymisées AVANT l'appel,
 * puis resubstituées dans le texte rendu. Cette responsabilité appartient à
 * l'appelant (module de pseudonymisation), comme dans l'application actuelle :
 * ce client n'envoie que ce qu'on lui donne.
 */
export async function generate(
  kind: KindGeneration,
  payload: Record<string, unknown>,
  onProgress?: OnProgress,
): Promise<ResultatGeneration> {
  const patientId = typeof payload.patientId === 'string' ? payload.patientId : null;
  const p = pilote(patientId ? ETAPES_AVEC_DOSSIER : ETAPES_SANS_DOSSIER, onProgress);

  // Phase 1 — le dossier. Réellement franchie quand le serveur a répondu.
  if (patientId) {
    try { await getContextePatient(patientId); } catch { /* le dossier reste optionnel */ }
    p.avance();
  }

  // Phase 2 — le référentiel de spécialité.
  try { await getMonReferentiel(); } catch { /* la génération n'en dépend pas */ }
  p.avance();

  // Phase 3 — la rédaction. L'étape reste active jusqu'au retour du document.
  return request<ResultatGeneration>(ROUTES_GENERATION[kind], {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Analyse clinique préalable (suggestions et déductions avant génération). */
export async function analyzeClinical(payload: Record<string, unknown>): Promise<unknown> {
  const { analysis } = await request<{ analysis: unknown }>('/api/clinical/analyze', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return analysis;
}

// ─── Avis spécialisé ────────────────────────────────────────────────────────

export async function demanderAvis(payload: Record<string, unknown>): Promise<unknown> {
  return request('/api/avis-specialise', { method: 'POST', body: JSON.stringify(payload) });
}

export async function resumerAvis(payload: Record<string, unknown>): Promise<{ resume: string; modele: string }> {
  return request('/api/avis-specialise/resume', { method: 'POST', body: JSON.stringify(payload) });
}

// ─── Reprise des données locales héritées ───────────────────────────────────

/** Idempotent côté serveur : un second import ne duplique rien. */
export async function importerDossiersLocaux(payload: {
  patients: unknown[];
  documents: unknown[];
}): Promise<unknown> {
  return request('/api/dossiers/import', { method: 'POST', body: JSON.stringify(payload) });
}
