const db = window.supabase.createClient("https://cyosixmthqbrmqggcspw.supabase.co", "sb_publishable_oHFFl_L7hGW52cDjIpkEzg_78I9jY-t");

const QK = 'coco_offline_queue_v3';
const uuid = () => crypto.randomUUID();
const readQ = () => { try { return JSON.parse(localStorage.getItem(QK) || '[]'); } catch { return []; } };
const writeQ = a => localStorage.setItem(QK, JSON.stringify(a));
const ok = r => { if (r.error) throw r.error; return r.data; };

// Séance créée côté client (id UUID) : fonctionne aussi hors-ligne, la ligne est créée à l'envoi du premier exercice
async function createSession() {
  const id = uuid();
  try { ok(await db.from('sessions').insert({ id, date: new Date().toISOString() })); }
  catch { writeQ([...readQ(), { k: 'session', id, date: new Date().toISOString() }]); }
  return id;
}

async function pushSession(q) {
  ok(await db.from('sessions').upsert({ id: q.id, date: q.date }, { onConflict: 'id' }));
}

// Envoi idempotent : l'id de l'exercice est fixé côté client, les séries sont remplacées
async function pushExercise(p) {
  ok(await db.from('exercises').upsert({
    id: p.exId, session_id: p.sessionId, exercise_name: p.exerciseName, category: p.category,
    muscle_group: p.muscleGroup || null, difficulty_rating: p.difficulty || null, notes: p.notes || null
  }, { onConflict: 'id' }));
  ok(await db.from('sets').delete().eq('exercise_id', p.exId));
  let rows;
  if (p.category === 'cardio') {
    rows = [{ set_number: 1, speed: p.speed ?? null, incline: p.incline ?? null, duration_minutes: p.duration ?? null, distance_km: p.distance ?? null, is_warmup: false }];
  } else {
    rows = (p.dynamicSets || []).map(s => ({
      set_number: s.setNumber, weight: s.weight, reps: s.reps, is_warmup: !!s.isWarmup, rest_time: p.restTime || null
    }));
  }
  if (rows.length) ok(await db.from('sets').insert(rows.map(r => ({ exercise_id: p.exId, ...r }))));
}

let syncing = false;
async function syncOfflineQueue() {
  if (syncing) return;
  syncing = true;
  try {
    const snap = readQ(), rest = [];
    for (const q of snap) {
      try { q.k === 'session' ? await pushSession(q) : await pushExercise(q); } catch { rest.push(q); }
    }
    const done = new Set(snap.map(x => x.qid || x.id));
    writeQ([...rest, ...readQ().filter(x => !done.has(x.qid || x.id))]);
  } finally { syncing = false; }
}
addEventListener('online', syncOfflineQueue);

// Enregistre un exercice ; en cas d'échec réseau il est mis en file d'attente
async function recordSetData(p) {
  p = { ...p, k: 'exercise', exId: p.exId || uuid(), qid: uuid() };
  try {
    await syncOfflineQueue();
    await pushExercise(p);
  } catch (e) {
    writeQ([...readQ(), p]);
  }
}

const fetchSessionsHistory = async () => ok(await db.from('sessions').select(
  'id,date,exercises(id,exercise_name,category,muscle_group,difficulty_rating,notes,sets(set_number,weight,reps,rest_time,speed,duration_minutes,incline,distance_km,is_warmup))'
).order('date', { ascending: false }));

async function deleteSession(id) {
  const exs = ok(await db.from('exercises').select('id').eq('session_id', id));
  const ids = exs.map(e => e.id);
  if (ids.length) ok(await db.from('sets').delete().in('exercise_id', ids));
  ok(await db.from('exercises').delete().eq('session_id', id));
  ok(await db.from('sessions').delete().eq('id', id));
}

const fetchExerciseHistory = async name => ok(await db.from('exercises').select(
  'id,exercise_name,category,difficulty_rating,notes,sessions(date),sets(set_number,reps,weight,speed,incline,duration_minutes,distance_km,is_warmup)'
).eq('exercise_name', name));

async function fetchAllDistinctExercises() {
  const data = ok(await db.from('exercises').select('exercise_name,category'));
  const m = new Map();
  data.forEach(x => { if (!m.has(x.exercise_name)) m.set(x.exercise_name, x.category); });
  return [...m].map(([name, category]) => ({ name, category }));
}

const fetchTemplates = async () => ok(await db.from('workout_templates').select('*').order('created_at', { ascending: false }));
const saveWorkoutTemplate = async (name, exercises) => ok(await db.from('workout_templates').insert([{ name, exercises }]));
const deleteWorkoutTemplate = async id => ok(await db.from('workout_templates').delete().eq('id', id));

syncOfflineQueue();
