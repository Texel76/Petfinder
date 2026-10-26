// app.js - lógica de PetFinder (feed, mapa, subida de imágenes, likes, comentarios)

const BUCKET = 'publicaciones';
const MAX_BYTES = 5 * 1024 * 1024;
const TIPOS_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let currentUser = null;
let currentProfile = null;
let allPosts = [];
let activeFilter = 'all';
let selectedFile = null;
let pickedCoords = null;     // {lat, lng} elegido para la nueva publicación
let pickingOnMap = false;
let pickMarker = null;
let userCoords = null;       // ubicación GPS del usuario
let userCircle = null;
const markers = {};          // id de publicación -> marcador Leaflet

// ---------------------------------------------------------------- utilidades
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'Hace un momento';
  const m = Math.floor(s / 60);
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h} h`;
  return `Hace ${Math.floor(h / 24)} d`;
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtDist(km) {
  return km < 1 ? `A ${Math.round(km * 1000)} m de ti` : `A ${km.toFixed(1)} km de ti`;
}

let toastTimer;
function toast(msg, type = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3500);
}

// ---------------------------------------------------------------------- mapa
const initialCoords = [5.33573, -72.3939]; // Ubicacion de Yopal
const map = L.map('pet-map', { zoomControl: false }).setView(initialCoords, 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors',
}).addTo(map);

const createCustomIcon = (type, emoji) => L.divIcon({
  className: `custom-map-pin ${type}`,
  html: `<div class="pin-inner">${emoji}</div>`,
  iconSize: [42, 42],
  iconAnchor: [21, 42],
});

const emojiDe = (p) => (p.especie === 'dog' ? '🐶' : p.especie === 'cat' ? '🐱' : '🐾');

map.on('click', (e) => {
  if (!pickingOnMap) return;
  setPickedCoords(e.latlng.lat, e.latlng.lng);
  cancelPickOnMap(true);
});

function focusOnMap(lat, lng) {
  if (lat == null || lng == null) return;
  map.flyTo([lat, lng], 16, { duration: 1.2 });
}

function focusPost(id) {
  const p = allPosts.find((x) => x.id === id);
  if (!p || p.lat == null) return;
  focusOnMap(p.lat, p.lng);
  if (markers[id]) markers[id].openPopup();
}

function locateUser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Tu navegador no soporta geolocalización.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (userCircle) map.removeLayer(userCircle);
        userCircle = L.circle([userCoords.lat, userCoords.lng], {
          color: '#3B82F6', fillColor: '#60A5FA', fillOpacity: 0.25, radius: 300,
        }).addTo(map);
        resolve(userCoords);
      },
      () => reject(new Error('No se pudo obtener tu ubicación. Revisa los permisos del navegador.')),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

document.getElementById('btn-locate').addEventListener('click', async () => {
  try {
    const c = await locateUser();
    map.flyTo([c.lat, c.lng], 15);
    renderFeed();
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('location-search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const res = await r.json();
    if (!res.length) return toast('No se encontró ese lugar.', 'error');
    map.flyTo([parseFloat(res[0].lat), parseFloat(res[0].lon)], 15);
  } catch { toast('No se pudo buscar el lugar.', 'error'); }
});

// --------------------------------------------------------------- sesión / UI
async function init() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = 'registro.html'; return; }
  currentUser = session.user;

  const { data } = await supabaseClient
    .from('perfiles').select('username, avatar_url').eq('id', currentUser.id).maybeSingle();
  currentProfile = data || { username: (currentUser.email || 'usuario').split('@')[0] };

  document.getElementById('user-name').textContent = '@' + currentProfile.username;
  document.getElementById('user-initial').textContent = currentProfile.username.charAt(0).toUpperCase();

  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.href = 'registro.html';
  });

  await loadPosts();
}

async function logout() {
  await supabaseClient.auth.signOut();
  window.location.href = 'registro.html';
}

// -------------------------------------------------------------- publicaciones
async function loadPosts() {
  const { data, error } = await supabaseClient
    .from('publicaciones')
    .select('*, perfiles!publicaciones_user_id_fkey(username, avatar_url), likes(user_id), comentarios(count)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error(error);
    document.getElementById('posts-feed').innerHTML =
      `<div class="empty-state">No se pudieron cargar las publicaciones.<br><small>${esc(error.message)}</small></div>`;
    return;
  }
  allPosts = data || [];
  updateStats();
  renderFeed();
}

function updateStats() {
  const lost = allPosts.filter((p) => p.tipo === 'lost').length;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const sighted = allPosts.filter((p) => p.tipo === 'sighted' && new Date(p.created_at).getTime() >= dayAgo).length;
  document.getElementById('stat-lost').textContent = lost;
  document.getElementById('stat-sighted').textContent = sighted;
}

function matchesFilter(p) {
  switch (activeFilter) {
    case 'lost': return p.tipo === 'lost';
    case 'sighted': return p.tipo === 'sighted';
    case 'dog': return p.especie === 'dog';
    case 'cat': return p.especie === 'cat';
    default: return true;
  }
}

function postHTML(p) {
  const lost = p.tipo === 'lost';
  const author = p.perfiles?.username || 'Usuario';
  const likes = p.likes || [];
  const liked = likes.some((l) => l.user_id === currentUser.id);
  const nComments = p.comentarios?.[0]?.count ?? 0;
  const hasCoords = p.lat != null && p.lng != null;
  const dist = (userCoords && hasCoords)
    ? ' • 📍 ' + fmtDist(distanceKm(userCoords.lat, userCoords.lng, p.lat, p.lng)) : '';

  return `
  <article class="post-card ${lost ? 'lost-type' : 'sighted-type'}" id="post-${p.id}">
    <div class="post-header">
      <div class="author-info">
        <div class="author-avatar author-initial">${esc(author.charAt(0).toUpperCase())}</div>
        <div>
          <h4 class="author-name">@${esc(author)}</h4>
          <span class="post-time">${timeAgo(p.created_at)}${dist}</span>
        </div>
      </div>
      <span class="badge-status ${lost ? 'badge-lost' : 'badge-sighted'}">${lost ? 'PERDIDO' : 'AVISTADO'}</span>
    </div>

    ${p.imagen_url ? `
    <div class="post-media" ${hasCoords ? `onclick="focusPost(${p.id})"` : ''}>
      <img src="${esc(p.imagen_url)}" alt="${esc(p.titulo)}" loading="lazy">
      ${hasCoords ? '<div class="media-overlay"><span>📍 Toca para ubicar en mapa</span></div>' : ''}
    </div>` : ''}

    <div class="post-body">
      <h3 class="pet-name">${emojiDe(p)} ${esc(p.titulo)}</h3>
      <p class="post-text">${esc(p.descripcion)}</p>
      ${p.ubicacion_texto ? `<div class="location-tag"><span>📍 ${lost ? 'Última vez visto' : 'Visto en'}: <strong>${esc(p.ubicacion_texto)}</strong></span></div>` : ''}
    </div>

    <div class="post-actions">
      <button class="action-btn ${liked ? 'liked' : ''}" onclick="toggleLike(${p.id}, this)">
        <span class="icon">❤️</span> <span class="count">${likes.length}</span>
      </button>
      <button class="action-btn" onclick="toggleComments(${p.id})">
        <span class="icon">💬</span> <span class="count" id="ccount-${p.id}">${nComments} pistas</span>
      </button>
      <button class="action-btn" onclick="sharePost(${p.id})">
        <span class="icon">📲</span> Difundir
      </button>
      ${p.user_id === currentUser.id ? `<button class="action-btn danger" onclick="deletePost(${p.id})">🗑️ Borrar</button>` : ''}
    </div>

    <div class="comments-section" id="comments-${p.id}">
      <div id="comments-list-${p.id}"></div>
      <div class="add-comment-box">
        <input type="text" id="comment-input-${p.id}" maxlength="500" placeholder="Escribe una pista o comentario..."
               onkeydown="if(event.key==='Enter') sendComment(${p.id})">
        <button onclick="sendComment(${p.id})">Enviar</button>
      </div>
    </div>
  </article>`;
}

function renderFeed() {
  const feed = document.getElementById('posts-feed');
  const list = allPosts.filter(matchesFilter);
  feed.innerHTML = list.length
    ? list.map(postHTML).join('')
    : '<div class="empty-state">Aún no hay publicaciones aquí. ¡Sé el primero en publicar!</div>';
  renderMarkers(list);
}

function renderMarkers(list) {
  Object.values(markers).forEach((m) => map.removeLayer(m));
  for (const k of Object.keys(markers)) delete markers[k];

  list.forEach((p) => {
    if (p.lat == null || p.lng == null) return;
    const m = L.marker([p.lat, p.lng], { icon: createCustomIcon(p.tipo, emojiDe(p)) }).addTo(map);
    const popup = document.createElement('div');
    popup.className = 'map-popup';
    popup.innerHTML = `
      ${p.imagen_url ? `<img src="${esc(p.imagen_url)}" alt="${esc(p.titulo)}">` : ''}
      <h4>${esc(p.titulo)} (${p.tipo === 'lost' ? 'Perdido' : 'Avistado'})</h4>
      <p>${timeAgo(p.created_at)} • @${esc(p.perfiles?.username || 'Usuario')}</p>`;
    m.bindPopup(popup);
    markers[p.id] = m;
  });
}

function filterFeed(type, btn) {
  activeFilter = type;
  document.querySelectorAll('.filter-chip').forEach((b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderFeed();
}

// --------------------------------------------------------------------- likes
async function toggleLike(id, btn) {
  const p = allPosts.find((x) => x.id === id);
  if (!p) return;
  const liked = (p.likes || []).some((l) => l.user_id === currentUser.id);

  btn.disabled = true;
  const { error } = liked
    ? await supabaseClient.from('likes').delete().eq('post_id', id).eq('user_id', currentUser.id)
    : await supabaseClient.from('likes').insert({ post_id: id, user_id: currentUser.id });
  btn.disabled = false;

  if (error) return toast('No se pudo registrar tu like.', 'error');

  p.likes = liked
    ? p.likes.filter((l) => l.user_id !== currentUser.id)
    : [...(p.likes || []), { user_id: currentUser.id }];
  btn.classList.toggle('liked', !liked);
  btn.querySelector('.count').textContent = p.likes.length;
}

// --------------------------------------------------------------- comentarios
const loadedComments = new Set();

async function toggleComments(id) {
  const sec = document.getElementById(`comments-${id}`);
  sec.classList.toggle('active');
  if (sec.classList.contains('active') && !loadedComments.has(id)) {
    await loadComments(id);
    loadedComments.add(id);
  }
}

async function loadComments(id) {
  const list = document.getElementById(`comments-list-${id}`);
  const { data, error } = await supabaseClient
    .from('comentarios')
    .select('id, texto, created_at, perfiles!comentarios_user_id_fkey(username)')
    .eq('post_id', id)
    .order('created_at', { ascending: true });

  if (error) { list.innerHTML = '<div class="comment-item">No se pudieron cargar las pistas.</div>'; return; }
  list.innerHTML = (data || []).length
    ? data.map((c) => `<div class="comment-item"><strong>@${esc(c.perfiles?.username || 'Usuario')}:</strong> ${esc(c.texto)}</div>`).join('')
    : '<div class="comment-item muted">Todavía no hay pistas. ¡Aporta la primera!</div>';
  const label = document.getElementById(`ccount-${id}`);
  if (label) label.textContent = `${(data || []).length} pistas`;
}

async function sendComment(id) {
  const input = document.getElementById(`comment-input-${id}`);
  const texto = input.value.trim();
  if (!texto) return;
  input.disabled = true;
  const { error } = await supabaseClient
    .from('comentarios').insert({ post_id: id, user_id: currentUser.id, texto });
  input.disabled = false;
  if (error) return toast('No se pudo enviar el comentario.', 'error');
  input.value = '';
  await loadComments(id);
}

// ------------------------------------------------------- compartir / borrar
async function sharePost(id) {
  const url = `${location.origin}${location.pathname}#post-${id}`;
  try {
    if (navigator.share) await navigator.share({ title: 'PetFinder', url });
    else { await navigator.clipboard.writeText(url); toast('Enlace copiado al portapapeles.'); }
  } catch { /* el usuario canceló */ }
}

async function deletePost(id) {
  if (!confirm('¿Borrar esta publicación? No se puede deshacer.')) return;
  const p = allPosts.find((x) => x.id === id);

  // 1) borrar la fila  2) borrar la imagen del Storage
  const { error } = await supabaseClient.from('publicaciones').delete().eq('id', id);
  if (error) return toast('No se pudo borrar la publicación.', 'error');

  if (p?.imagen_url) {
    const marca = `/object/public/${BUCKET}/`;
    const i = p.imagen_url.indexOf(marca);
    if (i !== -1) {
      await supabaseClient.storage.from(BUCKET).remove([decodeURIComponent(p.imagen_url.slice(i + marca.length))]);
    }
  }
  allPosts = allPosts.filter((x) => x.id !== id);
  updateStats();
  renderFeed();
  toast('Publicación borrada.');
}

// --------------------------------------------------------------------- modal
function togglePostModal() {
  document.getElementById('post-modal').classList.toggle('active');
}

function resetPostForm() {
  document.getElementById('post-form').reset();
  selectedFile = null;
  pickedCoords = null;
  if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
  document.getElementById('photo-preview').style.display = 'none';
  document.getElementById('dropzone-text').textContent = 'Haz clic o arrastra una foto de la mascota';
  document.getElementById('coords-label').textContent = 'Aún no has marcado el punto en el mapa.';
}

function setPickedCoords(lat, lng) {
  pickedCoords = { lat, lng };
  if (pickMarker) map.removeLayer(pickMarker);
  pickMarker = L.marker([lat, lng]).addTo(map);
  document.getElementById('coords-label').textContent =
    `✅ Punto marcado (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
}

function startPickOnMap() {
  pickingOnMap = true;
  document.getElementById('post-modal').classList.remove('active');
  document.getElementById('map-hint').classList.add('show');
  document.getElementById('pet-map').style.cursor = 'crosshair';
}

function cancelPickOnMap(reopen = false) {
  pickingOnMap = false;
  document.getElementById('map-hint').classList.remove('show');
  document.getElementById('pet-map').style.cursor = '';
  document.getElementById('post-modal').classList.add('active');
}

document.getElementById('btn-pick-map').addEventListener('click', startPickOnMap);

document.getElementById('btn-use-gps').addEventListener('click', async () => {
  try {
    const c = await locateUser();
    setPickedCoords(c.lat, c.lng);
    map.flyTo([c.lat, c.lng], 16);
  } catch (err) { toast(err.message, 'error'); }
});

// Selección y vista previa de la foto
function handleFile(file) {
  if (!file) return;
  if (!TIPOS_OK.includes(file.type)) return toast('Formato no permitido. Usa JPG, PNG, WEBP o GIF.', 'error');
  if (file.size > MAX_BYTES) return toast('La imagen supera los 5 MB.', 'error');
  selectedFile = file;
  const prev = document.getElementById('photo-preview');
  prev.src = URL.createObjectURL(file);
  prev.style.display = 'block';
  document.getElementById('dropzone-text').textContent = file.name;
}

const fileInput = document.getElementById('pet-photo');
fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  if (!selectedFile) fileInput.value = '';
});

// ----------------------------------------------------------- publicar (subir)
async function submitPost(e) {
  e.preventDefault();

  if (!selectedFile) return toast('Agrega una fotografía de la mascota.', 'error');
  if (!pickedCoords) return toast('Marca la ubicación en el mapa o usa tu ubicación.', 'error');

  const btn = document.getElementById('btn-submit-post');
  btn.disabled = true;
  btn.textContent = 'Publicando...';

  const ext = (selectedFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `${currentUser.id}/${Date.now()}.${ext}`;

  try {
    // 1) Subir la imagen al bucket
    const { error: upErr } = await supabaseClient.storage
      .from(BUCKET).upload(path, selectedFile, { contentType: selectedFile.type, upsert: false });
    if (upErr) throw upErr;

    const { data: { publicUrl } } = supabaseClient.storage.from(BUCKET).getPublicUrl(path);

    // 2) Guardar la publicación
    const { error: insErr } = await supabaseClient.from('publicaciones').insert({
      user_id: currentUser.id,
      tipo: document.querySelector('input[name="postType"]:checked').value,
      especie: document.getElementById('pet-species').value,
      titulo: document.getElementById('pet-title').value.trim(),
      descripcion: document.getElementById('pet-desc').value.trim(),
      ubicacion_texto: document.getElementById('pet-place').value.trim(),
      lat: pickedCoords.lat,
      lng: pickedCoords.lng,
      imagen_url: publicUrl,
    });

    if (insErr) {
      await supabaseClient.storage.from(BUCKET).remove([path]); // no dejar imágenes huérfanas
      throw insErr;
    }

    const coords = { ...pickedCoords };
    resetPostForm();
    document.getElementById('post-modal').classList.remove('active');
    await loadPosts();
    focusOnMap(coords.lat, coords.lng);
    toast('¡Publicación creada en el radar!');
  } catch (err) {
    console.error(err);
    toast('No se pudo publicar: ' + (err.message || 'error desconocido'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Publicar en el Radar';
  }
}

init().catch((err) => {
  console.error(err);
  document.getElementById('posts-feed').innerHTML =
    `<div class="empty-state">Error al iniciar: ${esc(err.message)}. Revisa conexion.js y la consola (F12).</div>`;
});