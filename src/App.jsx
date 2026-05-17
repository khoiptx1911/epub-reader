import { useState, useEffect, useRef } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import ePub from 'epubjs';
import localforage from 'localforage';
import { CLIENT_ID } from './config';

const globalStyle = document.createElement('style');
globalStyle.textContent = `
  @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { width: 100%; height: 100%; overflow: hidden; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 4px; }
`;
document.head.appendChild(globalStyle);

function App() {
  const [accessToken, setAccessToken] = useState(null);
  const [files, setFiles]             = useState([]);
  const [loading, setLoading]         = useState(false);
  const [currentBook, setCurrentBook] = useState(null);
  const [fontSize, setFontSize]       = useState(100);
  const [isDark, setIsDark]           = useState(true);
  const [toc, setToc]                 = useState([]);
  const [tocOpen, setTocOpen]         = useState(true);
  const [expandedItems, setExpandedItems] = useState({});

  const renditionRef = useRef(null);
  const bookRef      = useRef(null);
  const viewerRef    = useRef(null);   // div#viewer — chứa các iframe
  const wrapperRef   = useRef(null);   // div cuộn thật sự
  const isDarkRef    = useRef(isDark);
  const fontSizeRef  = useRef(fontSize);

  useEffect(() => { isDarkRef.current  = isDark;   }, [isDark]);
  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);

  /* ─── Google login & silent refresh (GIS token client) ─── */
  const tokenClientRef = useRef(null);
  const refreshTimeoutRef = useRef(null);

  const syncIntervalRef = useRef(null);
  const lastLocationRef = useRef(null);
  const savingRef = useRef(false);

  const posKey = (fileId) => `pos:${fileId}`;

  const getCurrentCfi = () => {
    try {
      const rend = renditionRef.current;
      if (!rend) return null;
      let loc = null;
      if (lastLocationRef.current) loc = lastLocationRef.current;
      if (!loc && typeof rend.currentLocation === 'function') loc = rend.currentLocation();
      if (!loc && rend.location) loc = rend.location;
      if (!loc && rend.manager && typeof rend.manager.currentLocation === 'function') loc = rend.manager.currentLocation();
      const cfi = (loc && (loc.start && loc.start.cfi)) || loc?.cfi || (typeof loc === 'string' ? loc : null);
      return cfi || null;
    } catch (err) { return null; }
  };

  const savePositionLocal = async (fileId, pos) => {
    try { await localforage.setItem(posKey(fileId), pos); } catch (err) { console.warn('savePositionLocal err', err); }
  };

  const savePositionToDrive = async (fileId, pos) => {
    if (!accessToken) return;
    try {
      const name = `epubpos_${fileId}.json`;
      const q = `name='${name}' and 'appDataFolder' in parents`;
      const listUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=${encodeURIComponent(q)}`;
      const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!listRes.ok) {
        if (listRes.status === 401 && tokenClientRef.current) {
          try { tokenClientRef.current.requestAccessToken({ prompt: '' }); } catch (_) {}
        }
        return;
      }
      const listJson = await listRes.json();
      console.debug('[epub] savePositionToDrive listJson', listJson);
      const metadata = { name, parents: ['appDataFolder'], mimeType: 'application/json' };
      const boundary = '-------314159265358979323846';
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(pos)}\r\n--${boundary}--`;
      if (listJson.files && listJson.files.length) {
        const fid = listJson.files[0].id;
        const upd = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fid}?uploadType=multipart&spaces=appDataFolder`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
        if (!upd.ok) {
          const t = await upd.text();
          console.warn('[epub] savePositionToDrive update failed', upd.status, t);
        } else {
          console.debug('[epub] savePositionToDrive updated', fid);
        }
      } else {
        const created = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&spaces=appDataFolder`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
        if (!created.ok) {
          const t = await created.text();
          console.warn('[epub] savePositionToDrive create failed', created.status, t);
        } else {
          const j = await created.json().catch(() => null);
          console.debug('[epub] savePositionToDrive created', j?.id || '(no-id)');
        }
      }
    } catch (err) { console.warn('savePositionToDrive err', err); }
  };

  const loadPositionFromDrive = async (fileId) => {
    if (!accessToken) return null;
    try {
      const name = `epubpos_${fileId}.json`;
      const q = `name='${name}' and 'appDataFolder' in parents`;
      const listUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=${encodeURIComponent(q)}`;
      const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!listRes.ok) {
        if (listRes.status === 401 && tokenClientRef.current) {
          try { tokenClientRef.current.requestAccessToken({ prompt: '' }); } catch (_) {}
        }
        return null;
      }
      const listJson = await listRes.json();
      console.debug('[epub] loadPositionFromDrive listJson', listJson);
      if (listJson.files && listJson.files.length) {
        const fid = listJson.files[0].id;
        const getRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fid}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!getRes.ok) {
          const t = await getRes.text().catch(() => null);
          console.warn('[epub] loadPositionFromDrive getRes not ok', getRes.status, t);
          if (getRes.status === 401 && tokenClientRef.current) {
            try { tokenClientRef.current.requestAccessToken({ prompt: '' }); } catch (_) {}
          }
          return null;
        }
        const text = await getRes.text();
        try { const obj = JSON.parse(text); return obj; } catch (err) { console.warn('[epub] loadPositionFromDrive parse err', err); return null; }
      }
      return null;
    } catch (err) { console.warn('loadPositionFromDrive err', err); return null; }
  };

  const saveCurrentPosition = async (fileId) => {
    if (!fileId) return;
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const cfi = getCurrentCfi();
      if (!cfi) return;
      const pos = { cfi, ts: Date.now() };
      await savePositionLocal(fileId, pos);
      await savePositionToDrive(fileId, pos);
    } catch (err) { console.warn('saveCurrentPosition err', err); }
    finally { savingRef.current = false; }
  };

  const startPositionSync = (fileId) => {
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => { saveCurrentPosition(fileId); }, 60 * 1000);
  };

  const stopPositionSync = async (fileId) => {
    if (syncIntervalRef.current) { clearInterval(syncIntervalRef.current); syncIntervalRef.current = null; }
    if (fileId) await saveCurrentPosition(fileId);
  };

  const setTokenAndSchedule = async (token, expiresInSec = 3600) => {
    setAccessToken(token);
    const expiresAt = Date.now() + expiresInSec * 1000;
    try { await localforage.setItem('accessToken', { token, expiresAt }); } catch (_) {}
    // schedule refresh 60s before expiry
    if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    const ms = expiresAt - Date.now() - 60 * 1000;
    if (ms <= 0) {
      // immediate attempt
      if (tokenClientRef.current) tokenClientRef.current.requestAccessToken({ prompt: '' });
    } else {
      refreshTimeoutRef.current = setTimeout(() => {
        if (tokenClientRef.current) tokenClientRef.current.requestAccessToken({ prompt: '' });
      }, ms);
    }
  };

  const silentRefresh = () => {
    if (!tokenClientRef.current) return;
    try { tokenClientRef.current.requestAccessToken({ prompt: '' }); }
    catch (err) { console.warn('silent refresh failed', err); }
  };

  const initTokenClient = () => {
    try {
      if (window.google?.accounts?.oauth2) {
        tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: 'https://www.googleapis.com/auth/drive.appdata',
          callback: (resp) => {
            if (resp && resp.access_token) {
              setTokenAndSchedule(resp.access_token, resp.expires_in || 3600);
            } else {
              console.warn('token client callback', resp);
            }
          },
        });
      }
    } catch (err) { console.warn('initTokenClient err', err); }
  };

  // Interactive login using GIS token client to ensure drive.appdata scope is granted
  const login = async () => {
    try {
      if (!tokenClientRef.current) {
        // try to init if script loaded
        if (window.google?.accounts?.oauth2) initTokenClient();
        // wait briefly for tokenClient to become available
        let waited = 0;
        while (!tokenClientRef.current && waited < 3000) { await new Promise(r => setTimeout(r, 100)); waited += 100; }
        if (!tokenClientRef.current) {
          console.warn('login: token client not ready');
          return;
        }
      }
      // Prompt for consent to ensure scopes are granted
      tokenClientRef.current.requestAccessToken({ prompt: 'consent' });
    } catch (err) {
      console.warn('login err', err);
    }
  };

  // Load GIS script and init token client
  useEffect(() => {
    if (window.google?.accounts?.oauth2) { initTokenClient(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => initTokenClient();
    document.head.appendChild(s);
    return () => {};
  }, []);

  /* ─── Lấy phiên đăng nhập từ cache (localForage) ─── */
  useEffect(() => {
    (async () => {
      try {
        const s = await localforage.getItem('accessToken');
        if (s && s.token && s.expiresAt && s.expiresAt > Date.now()) {
          setAccessToken(s.token);
          // schedule refresh
          const ms = s.expiresAt - Date.now() - 60 * 1000;
          if (ms <= 0) {
            if (tokenClientRef.current) tokenClientRef.current.requestAccessToken({ prompt: '' });
          } else {
            refreshTimeoutRef.current = setTimeout(() => {
              if (tokenClientRef.current) tokenClientRef.current.requestAccessToken({ prompt: '' });
            }, ms);
          }
        } else if (s) {
          await localforage.removeItem('accessToken');
        }
      } catch (_) {}
    })();
  }, []);

  /* ─── Lấy danh sách sách ─── */
  const fetchFiles = async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const h = { headers: { Authorization: `Bearer ${accessToken}` } };
      const d = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=name='data' and 'root' in parents and mimeType='application/vnd.google-apps.folder'`, h)).json();
      if (!d.files?.length) { setLoading(false); return; }
      const e = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=name='epub' and '${d.files[0].id}' in parents`, h)).json();
      if (!e.files?.length) { setLoading(false); return; }
      const f = await (await fetch(`https://www.googleapis.com/drive/v3/files?q='${e.files[0].id}' in parents and name contains '.epub'`, h)).json();
      setFiles(f.files || []);
    } catch (err) { console.error(err); }
    setLoading(false);
  };

  useEffect(() => { if (accessToken) fetchFiles(); }, [accessToken]);

  // Save position on tab close / visibility change
  useEffect(() => {
    const onBeforeUnload = () => { if (currentBook) saveCurrentPosition(currentBook); };
    const onVisibility = () => { if (document.visibilityState === 'hidden' && currentBook) saveCurrentPosition(currentBook); };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [currentBook, accessToken]);

  /* ─── Re-apply theme khi đổi dark/fontSize ─── */
  useEffect(() => {
    if (!renditionRef.current) return;
    getAllViews(renditionRef.current).forEach(v => applyStyle(v, isDark, fontSize));
  }, [isDark, fontSize]);

  /* ─── Lấy tất cả view đang active ─── */
  const getAllViews = (rendition) => {
    try { return rendition.manager?.views?._views || []; }
    catch { return []; }
  };

  const getChildren = (item) => item.subitems || item.children || item.items || item.nav || [];

  const toggleExpand = (key) => {
    setExpandedItems(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const renderTocItems = (items, level = 0, parentKey = '') => {
    if (!items || !items.length) return null;
    return items.map((item, idx) => {
      const children = getChildren(item) || [];
      const itemKey = `${parentKey}-${idx}`;
      const isExpanded = expandedItems[itemKey];
      const label = (item.label && (item.label.text || item.label)) || item.title || item.text || item.href || item.id || 'Untitled';
      const hasChildren = children.length > 0 && level < 3;

      return (
        <li key={itemKey} style={{ marginBottom: '6px', paddingLeft: `${Math.min(level, 3) * 32}px` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {hasChildren && (
              <button
                onClick={() => toggleExpand(itemKey)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: c.accent,
                  fontSize: '0.9rem',
                  width: '16px',
                }}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            )}
            <button
              onClick={() => renditionRef.current && renditionRef.current.display(item.href || item.id || item.link || item.target)}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                textAlign: 'left',
                color: c.tocText,
                cursor: 'pointer',
                fontSize: '0.9rem',
                flex: 1,
              }}
            >
              {label}
            </button>
          </div>
          {hasChildren && isExpanded && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {renderTocItems(children, level + 1, itemKey)}
            </ul>
          )}
        </li>
      );
    });
  };

  /* ─── Inject style + resize iframe theo nội dung thật ─── */
  const applyStyle = (view, dark, size) => {
    try {
      const bg      = dark ? '#1c1c1c' : '#f5f0e8';
      const color   = dark ? '#d0ccc4' : '#2c2421';
      const heading = dark ? '#e8e4dc' : '#1a1008';
      const link    = dark ? '#16a34a' : '#16a34a';

      /* --- style iframe element --- */
      const iframe = view.iframe;
      if (iframe) {
        iframe.style.border      = 'none';
        iframe.style.outline     = 'none';
        iframe.style.display     = 'block';
        iframe.style.width       = '100%';
        iframe.style.maxWidth    = '1080px';
        iframe.style.margin      = '0 auto';
        iframe.style.background  = bg;
        // QUAN TRỌNG: không set height ở đây — sẽ set sau (đặt = chiều cao khung xem để iframe tự cuộn)
      }

      const doc = view.document || view.contents?.document;
      if (!doc || !doc.body) return;

      /* --- inject <style> vào iframe document --- */
      const old = doc.getElementById('__t__');
      if (old) old.remove();
      const s = doc.createElement('style');
      s.id = '__t__';
      s.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap');
        html {
          background: ${bg} !important;
          overflow: hidden !important;   /* iframe không tự cuộn */
          border: none !important;
        }
        body {
          background: ${bg} !important;
          color: ${color} !important;
          font-family: 'Be Vietnam Pro', sans-serif !important;
          font-size: ${size}% !important;
          line-height: 1.85 !important;
          max-width: 1080px !important;
          margin: 0 auto !important;
          padding: 28px 32px 60px !important;
          overflow-x: hidden !important;
          overflow-y: hidden !important; /* iframe không tự cuộn */
          border: none !important;
        }
        p  { color: ${color} !important; margin-bottom: 1em !important; font-weight: 300 !important; text-align: justify !important; }
        h1,h2,h3,h4,h5,h6 { color: ${heading} !important; font-weight: 600 !important; margin: 1.2em 0 0.5em !important; }
        a  { color: ${link} !important; text-decoration: none !important; }
        img { max-width: 100% !important; height: auto !important;
              filter: ${dark ? 'brightness(0.82)' : 'none'} !important; }
      `;
      doc.head.appendChild(s);

      /* --- Style .notes-section (footnotes) --- */
      const notesStyle = doc.createElement('style');
      notesStyle.id = '__notes_style__';
      notesStyle.textContent = `
        .notes-section {
          margin-top: 40px !important;
          border-top: 1px solid ${heading} !important;
          padding-top: 20px !important;
        }
        .notes-section h3 {
          font-size: 1.2em !important;
          margin-bottom: 15px !important;
          color: ${heading} !important;
        }
        .notes-section ol {
          padding-left: 20px !important;
          margin: 0 !important;
        }
        .notes-section li {
          margin-bottom: 10px !important;
          color: ${color} !important;
          font-size: 0.95em !important;
        }
        .notes-section a {
          color: ${link} !important;
          text-decoration: none !important;
        }
        sup a {
          color: ${link} !important;
          font-weight: bold !important;
          text-decoration: none !important;
        }
      `;
      doc.head.appendChild(notesStyle);
      doc.documentElement.style.background = bg;
      doc.body.style.background = bg;

      // fragment links handled by iframe's native scrolling


      /* --- Thêm nút 'Next chapter' vào cuối mỗi chương --- */
      try {
        const NEXT_ID = '__epub_next_btn__';
        let nextBtn = doc.getElementById(NEXT_ID);
        if (!nextBtn) {
          nextBtn = doc.createElement('button');
          nextBtn.id = NEXT_ID;
          nextBtn.textContent = 'Chương tiếp →';
          nextBtn.style.display = 'block';
          nextBtn.style.margin = '40px auto 20px';
          nextBtn.style.padding = '12px 20px';
          nextBtn.style.borderRadius = '8px';
          nextBtn.style.border = 'none';
          nextBtn.style.cursor = 'pointer';
          nextBtn.style.background = link;
          nextBtn.style.color = '#ffffff';
          nextBtn.style.fontWeight = '600';
          nextBtn.style.fontFamily = "'Be Vietnam Pro', sans-serif";
          nextBtn.style.fontSize = '1rem';
          nextBtn.addEventListener('click', () => { try { window.parent.postMessage({ type: 'epub-next' }, '*'); } catch (_) {} });
          doc.body.appendChild(nextBtn);
        }
      } catch (_) {}

      /* --- Resize iframe = scrollHeight thật của body --- */
      // Dùng requestAnimationFrame để đợi font/image load xong
      const resize = () => {
        try {
          const h = doc.body.scrollHeight || doc.documentElement.scrollHeight;
          if (h > 0 && iframe) {
            iframe.style.height = h + 'px';
            // Sau khi resize iframe, wrapper ngoài sẽ tự cuộn đúng
          }
        } catch (_) {}
      };

      requestAnimationFrame(() => {
        resize();
        // Resize lần 2 sau khi font load (Be Vietnam Pro load async)
        setTimeout(resize, 600);
        setTimeout(resize, 1500);
      });

    } catch (err) {
      console.warn('applyStyle err:', err);
    }
  };

  /* ─── Mở sách ─── */
  const openBook = async (fileId) => {
    setLoading(true);
    // stop previous sync if any
    try { if (currentBook && currentBook !== fileId) await stopPositionSync(currentBook); } catch (_) {}
    setCurrentBook(fileId);

    if (renditionRef.current) { try { renditionRef.current.destroy(); } catch (_) {} renditionRef.current = null; }
    if (bookRef.current)      { try { bookRef.current.destroy();      } catch (_) {} bookRef.current = null; }
    if (viewerRef.current)    viewerRef.current.innerHTML = '';
    if (viewerRef.current)    viewerRef.current.scrollTop = 0;
    if (wrapperRef.current)   wrapperRef.current.scrollTop = 0;

    try {
      let bookData = await localforage.getItem(fileId);
      if (!bookData) {
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        bookData = await res.arrayBuffer();
        await localforage.setItem(fileId, bookData);
      }

      const book = ePub(bookData);
      bookRef.current = book;

      // Load TOC if present
      try {
        const nav = await book.loaded.navigation;
        setToc(nav?.toc || book.navigation?.toc || []);
      } catch (_) {
        setToc(book.navigation?.toc || []);
      }

      const rendition = book.renderTo('viewer', {
        width:   '100%',
        flow:    'scrolled',
        manager: 'default',
      });

      rendition.on('rendered', (_sec, view) => {
        applyStyle(view, isDarkRef.current, fontSizeRef.current);
        try {
          const doc = view.document || view.contents?.document;
          if (doc && doc.body) {
            const noteSections = doc.querySelectorAll('.notes-section');
            Array.from(noteSections).forEach((section, idx) => {
              if (idx > 0) section.remove();
            });
          }
        } catch (_) {}
      });

      rendition.on('relocated', (location) => {
        // Reset scroll to top khi chuyển chapter
        if (viewerRef.current) viewerRef.current.scrollTop = 0;
        lastLocationRef.current = location;
      });

      // Try restore saved position: use local immediately, then try Drive and override if newer
      try {
        // fast local restore
        let localSaved = null;
        try { localSaved = await localforage.getItem(posKey(fileId)); } catch (_) { localSaved = null; }
        if (localSaved && localSaved.cfi) {
          console.debug('[epub] restore local', fileId, localSaved);
          await rendition.display(localSaved.cfi);
        } else {
          await rendition.display();
        }

        // then try Drive and override if newer
        let driveSaved = null;
        if (accessToken) {
          try { driveSaved = await loadPositionFromDrive(fileId); } catch (_) { driveSaved = null; }
        }
        if (driveSaved && driveSaved.cfi) {
          const localTs = localSaved?.ts || 0;
          const driveTs = driveSaved.ts || 0;
          if (!localSaved || driveTs > localTs) {
            console.debug('[epub] override with drive', fileId, driveSaved);
            await rendition.display(driveSaved.cfi);
            try { await savePositionLocal(fileId, driveSaved); } catch (_) {}
          }
        }
      } catch (err) {
        console.warn('[epub] restore pos err', err);
        try { await rendition.display(); } catch (_) {}
      }

      renditionRef.current = rendition;
      window.__epubRendition__ = rendition;  // global ref cho next button

      // Start periodic sync and save initial position
      startPositionSync(fileId);
      saveCurrentPosition(fileId);

    } catch (err) {
      console.error(err);
      alert('Lỗi mở sách: ' + err.message);
    }
    setLoading(false);
  };

  const goBack = async () => {
    try { if (currentBook) await stopPositionSync(currentBook); } catch (_) {}
    if (renditionRef.current) { try { renditionRef.current.destroy(); } catch (_) {} renditionRef.current = null; }
    if (bookRef.current)      { try { bookRef.current.destroy();      } catch (_) {} bookRef.current = null; }
    if (viewerRef.current)    viewerRef.current.innerHTML = '';
    setCurrentBook(null);
  };

  const changeFontSize = (delta) => {
    const next = Math.min(200, Math.max(60, fontSize + delta));
    setFontSize(next);
  };

  // Lắng nghe message từ iframe (nút Next chapter)
  useEffect(() => {
    const handler = (e) => {
      try {
        if (e.data && e.data.type === 'epub-next') {
          renditionRef.current && typeof renditionRef.current.next === 'function' && renditionRef.current.next();
        }
      } catch (_) {}
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Cleanup refresh timer and position sync on unmount
  useEffect(() => {
    return () => {
      try { if (refreshTimeoutRef?.current) clearTimeout(refreshTimeoutRef.current); } catch (_) {}
      try { if (syncIntervalRef?.current) clearInterval(syncIntervalRef.current); } catch (_) {}
      try { window.removeEventListener('beforeunload', window.__epub_save_on_unload); } catch (_) {}
    };
  }, []);

  /* ─── Colors ─── */
  const D = isDark;
  const c = {
    bg:      D ? '#121212' : '#f0ebe0',
    surface: D ? '#1e1e1e' : '#ffffff',
    header:  D ? '#181818' : '#fffdf7',
    border:  D ? '#2a2a2a' : '#ddd4c0',
    text:    D ? '#e0dcd6' : '#2c2421',
    sub:     D ? '#555'    : '#888',
    accent:  D ? '#16a34a' : '#16a34a',
    accent2: D ? '#86efac' : '#86efac',
    btnBg:   D ? '#16a34a' : '#16a34a',
    btnText: '#ffffff',
    reader:  D ? '#1c1c1c' : '#f5f0e8',
    tocText: '#ffffff',
  };

  const btn = {
    background: c.btnBg, color: c.btnText, border: 'none',
    padding: '5px 11px', borderRadius: '6px', cursor: 'pointer',
    fontSize: '0.82rem', fontFamily: "'Be Vietnam Pro', sans-serif", fontWeight: 500,
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      backgroundColor: c.bg, color: c.text,
      fontFamily: "'Be Vietnam Pro', sans-serif",
      transition: 'background-color 0.25s, color 0.25s',
    }}>

      {/* HEADER */}
      <div style={{
        padding: '10px 18px', background: c.header,
        borderBottom: `1px solid ${c.border}`, flexShrink: 0,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
      }}>
        <span onClick={goBack} style={{ cursor: 'pointer', color: c.accent, fontWeight: 700, fontSize: '0.98rem', userSelect: 'none' }}>
          📚 EPUB READER
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {currentBook && <>
            <button style={btn} onClick={() => setTocOpen(s => !s)}>{tocOpen ? '⇤ TOC' : '☰ TOC'}</button>
            <button style={btn} onClick={() => changeFontSize(-10)}>A−</button>
            <span style={{ color: c.sub, fontSize: '0.76rem', minWidth: '32px', textAlign: 'center' }}>{fontSize}%</span>
            <button style={btn} onClick={() => changeFontSize(10)}>A+</button>
            <button style={btn} onClick={goBack}>← Thư viện</button>
          </>}
        </div>
      </div>

      {/* ĐĂNG NHẬP */}
      {!accessToken && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '14px' }}>
          <div style={{ fontSize: '2.5rem' }}>📖</div>
          <div style={{ color: c.sub, fontSize: '0.9rem' }}>Đọc sách EPUB từ Google Drive</div>
          <button onClick={() => login()} style={{
            padding: '11px 28px', fontSize: '0.9rem', cursor: 'pointer',
            background: c.accent, color: '#fff', border: 'none', borderRadius: '8px',
            fontWeight: 600, fontFamily: "'Be Vietnam Pro', sans-serif",
            boxShadow: '0 4px 14px rgba(124,58,237,0.3)',
          }}>Đăng nhập Google</button>
        </div>
      )}

      {/* THƯ VIỆN */}
      {accessToken && !currentBook && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px' }}>
          <div style={{ color: c.accent2, marginBottom: '12px', fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1.2px' }}>
            Sách của bạn
          </div>
          {loading && <p style={{ color: c.sub, fontSize: '0.88rem' }}>Đang tải...</p>}
          {!loading && files.length === 0 && <p style={{ color: c.sub, fontSize: '0.88rem' }}>Không tìm thấy file .epub trong thư mục data/epub</p>}
          {files.map(file => (
            <div key={file.id} onClick={() => openBook(file.id)}
              style={{
                padding: '13px 16px', cursor: 'pointer', backgroundColor: c.surface,
                marginBottom: '7px', borderRadius: '9px', border: `1px solid ${c.border}`,
                display: 'flex', alignItems: 'center', gap: '11px', transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.backgroundColor = D ? '#242424' : '#eee8de'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = c.surface}
            >
              <span style={{ fontSize: '1.3rem' }}>📖</span>
              <span style={{ flex: 1, fontSize: '0.9rem' }}>{file.name.replace('.epub', '')}</span>
              <span style={{ color: c.sub, fontSize: '0.76rem' }}>▶ Đọc</span>
            </div>
          ))}
        </div>
      )}

      {/* ✅ VIEWER — epub-container (viewer) và mục lục (toc) */}
      {currentBook && (
        <div
          ref={wrapperRef}
          style={{
            position: 'relative',
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: c.reader,
            overflow: 'hidden',
            minHeight: 0,
          }}
        >
          {loading && (
            <div style={{ textAlign: 'center', padding: '80px 0', color: c.sub }}>
              <div style={{ fontSize: '2rem', marginBottom: '8px' }}>📖</div>
              <div style={{ fontSize: '0.86rem' }}>Đang tải nội dung...</div>
            </div>
          )}

          <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0 }}>
            <div
              id="viewer"
              ref={viewerRef}
              style={{
                width: '100%',
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                justifyContent: 'center',
              }}
            />
            {tocOpen && (
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: '300px',
                borderRight: `1px solid ${c.border}`,
                backgroundColor: c.surface,
                overflowY: 'auto',
                padding: '12px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 600, color: c.tocText }}>Mục lục</div>
                  <button style={{ ...btn, padding: '4px 8px' }} onClick={() => setTocOpen(false)}>✖</button>
                </div>
                {toc.length === 0 && <div style={{ color: c.sub, fontSize: '0.86rem' }}>Không có mục lục</div>}
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {renderTocItems(toc)}
                </ul>
              </div>
            )}

            {!tocOpen && (
              <button onClick={() => setTocOpen(true)} style={{ position: 'absolute', left: 8, top: 70, zIndex: 9999, ...btn, padding: '8px 10px' }}>☰</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;