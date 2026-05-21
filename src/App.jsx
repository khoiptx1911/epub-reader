import { useState, useEffect, useRef } from 'react';
import ePub from 'epubjs';
import localforage from 'localforage';
import { CLIENT_ID } from './config';

const globalStyle = document.createElement('style');
globalStyle.textContent = `
  @import url('https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { width: 100%; height: 100%; overflow: hidden; font-family: 'Nunito Sans', sans-serif; }
  * { font-family: 'Nunito Sans', sans-serif !important; }
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
  const [currentHref, setCurrentHref] = useState(null);
  const [currentPath, setCurrentPath] = useState([]);
  const [folderTree, setFolderTree] = useState(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [folderExpanded, setFolderExpanded] = useState({});
  const [currentFolderPath, setCurrentFolderPath] = useState([]);

  const renditionRef = useRef(null);
  const bookRef      = useRef(null);
  const viewerRef    = useRef(null);   // div#viewer — chứa các iframe
  const wrapperRef   = useRef(null);   // div cuộn thật sự
  const isDarkRef    = useRef(isDark);
  const fontSizeRef  = useRef(fontSize);

  useEffect(() => { isDarkRef.current  = isDark;   }, [isDark]);
  useEffect(() => { fontSizeRef.current = fontSize; }, [fontSize]);

  /* ─── Google login & silent refresh (GIS Authorization Code Flow + server) ─── */
  const codeClientRef = useRef(null);
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

  // Save position to Drive (uses accessToken); on 401 attempt silent refresh via server
  const savePositionToDrive = async (fileId, pos) => {
    if (!accessToken) return;
    try {
      const name = `epubpos_${fileId}.json`;
      const q = `name='${name}' and 'appDataFolder' in parents`;
      const listUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=${encodeURIComponent(q)}`;
      const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!listRes.ok) {
        if (listRes.status === 401) {
          try { await silentRefresh(); } catch (_) {}
        }
        return;
      }
      const listJson = await listRes.json();
      console.debug('[epub] savePositionToDrive listJson', listJson);
      const boundary = '-------314159265358979323846';
      if (listJson.files && listJson.files.length) {
        const fid = listJson.files[0].id;
        // For updates, do NOT include parents in metadata (not writable on update)
        const metadata = { name, mimeType: 'application/json' };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(pos)}\r\n--${boundary}--`;
        const upd = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fid}?uploadType=multipart&spaces=appDataFolder`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
          body,
        });
        if (!upd.ok) {
          const t = await upd.text();
          console.warn('[epub] savePositionToDrive update failed', upd.status, t);
          // Fallback: attempt simple media update (replace content only)
          try {
            const fallback = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fid}?uploadType=media&spaces=appDataFolder`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(pos),
            });
            if (!fallback.ok) {
              const ft = await fallback.text().catch(() => null);
              console.warn('[epub] savePositionToDrive fallback failed', fallback.status, ft);
            } else {
              console.debug('[epub] savePositionToDrive fallback media update ok', fid);
            }
          } catch (e) { console.warn('[epub] savePositionToDrive fallback err', e); }
        } else {
          console.debug('[epub] savePositionToDrive updated', fid);
        }
      } else {
        const metadata = { name, parents: ['appDataFolder'], mimeType: 'application/json' };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(pos)}\r\n--${boundary}--`;
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

  // Load position from Drive (uses accessToken); on 401 attempt silent refresh via server
  const loadPositionFromDrive = async (fileId) => {
    if (!accessToken) return null;
    try {
      const name = `epubpos_${fileId}.json`;
      const q = `name='${name}' and 'appDataFolder' in parents`;
      const listUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=${encodeURIComponent(q)}`;
      const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!listRes.ok) {
        if (listRes.status === 401) {
          try { await silentRefresh(); } catch (_) {}
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
          if (getRes.status === 401) {
            try { await silentRefresh(); } catch (_) {}
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

  // Server endpoint for code exchange and refresh
  const TOKEN_EXCHANGE_ENDPOINT = '/api/token-exchange';

  const postToServer = async (payload) => {
    try {
      const r = await fetch(TOKEN_EXCHANGE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw j || new Error('token-exchange failed');
      return j;
    } catch (err) { throw err; }
  };

  const exchangeCodeForTokens = async (code) => {
    return await postToServer({ code, redirect_uri: 'postmessage' });
  };

  const refreshAccessTokenWithServer = async (refreshToken) => {
    return await postToServer({ refresh_token: refreshToken });
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
      silentRefresh();
    } else {
      refreshTimeoutRef.current = setTimeout(() => {
        silentRefresh();
      }, ms);
    }
  };

  const silentRefresh = async () => {
    try {
      const rt = await localforage.getItem('refreshToken');
      if (!rt) {
        console.debug('[epub] silentRefresh: no refresh token');
        return;
      }
      const data = await refreshAccessTokenWithServer(rt);
      if (data && data.access_token) {
        try { await localforage.setItem('accessToken', { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 }); } catch (_) {}
        if (data.refresh_token) {
          try { await localforage.setItem('refreshToken', data.refresh_token); } catch (_) {}
        }
        setAccessToken(data.access_token);
        // schedule next
        if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
        const ms = (data.expires_in || 3600) * 1000 - 60 * 1000;
        refreshTimeoutRef.current = setTimeout(() => { silentRefresh(); }, ms > 0 ? ms : 0);
      } else {
        console.warn('[epub] silentRefresh failed', data);
        try { await localforage.removeItem('accessToken'); } catch (_) {}
        try { await localforage.removeItem('refreshToken'); } catch (_) {}
        setAccessToken(null);
      }
    } catch (err) { console.warn('silentRefresh err', err); }
  };

  const initCodeClient = () => {
    try {
      if (window.google?.accounts?.oauth2) {
        codeClientRef.current = window.google.accounts.oauth2.initCodeClient({
          client_id: CLIENT_ID,
          scope: 'https://www.googleapis.com/auth/drive.appdata',
          ux_mode: 'popup',
          callback: async (resp) => {
            if (resp && resp.code) {
              try {
                const data = await exchangeCodeForTokens(resp.code);
                if (data && data.access_token) {
                  if (data.refresh_token) {
                    try { await localforage.setItem('refreshToken', data.refresh_token); } catch (_) {}
                  }
                  await setTokenAndSchedule(data.access_token, data.expires_in || 3600);
                } else {
                  console.warn('code exchange response', data);
                }
              } catch (err) { console.warn('exchange err', err); }
            } else {
              console.warn('code client callback', resp);
            }
          },
        });
      }
    } catch (err) { console.warn('initCodeClient err', err); }
  };

  // Interactive login using GIS code client to ensure drive.appdata scope is granted
  const login = async () => {
    try {
      if (!codeClientRef.current) {
        // try to init if script loaded
        if (window.google?.accounts?.oauth2) initCodeClient();
        // wait briefly for codeClient to become available
        let waited = 0;
        while (!codeClientRef.current && waited < 3000) { await new Promise(r => setTimeout(r, 100)); waited += 100; }
        if (!codeClientRef.current) {
          console.warn('login: code client not ready');
          return;
        }
      }
      // Prompt for consent to ensure refresh token is issued
      try { codeClientRef.current.requestCode({ prompt: 'consent', access_type: 'offline' }); } catch (e) { codeClientRef.current.requestCode({ prompt: 'consent' }); }
    } catch (err) {
      console.warn('login err', err);
    }
  };

  // Load GIS script and init code client
  useEffect(() => {
    if (window.google?.accounts?.oauth2) { initCodeClient(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => initCodeClient();
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
          // schedule refresh using server-side silent refresh
          const ms = s.expiresAt - Date.now() - 60 * 1000;
          if (ms <= 0) {
            silentRefresh();
          } else {
            refreshTimeoutRef.current = setTimeout(() => { silentRefresh(); }, ms);
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
    setLibraryLoading(true);
    setLoading(true);
    try {
      const h = { headers: { Authorization: `Bearer ${accessToken}` } };
      // find data/epub folder (same logic as before)
      const dRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='data' and 'root' in parents and mimeType='application/vnd.google-apps.folder'`, h);
      const d = await dRes.json();
      if (!d.files?.length) { setFolderTree(null); setLibraryLoading(false); setLoading(false); return; }
      const eRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=name='epub' and '${d.files[0].id}' in parents and trashed=false`, h);
      const e = await eRes.json();
      if (!e.files?.length) { setFolderTree(null); setLibraryLoading(false); setLoading(false); return; }
      const epubFolder = e.files[0];

      const listChildren = async (parentId, pageToken = null) => {
        const q = `'${parentId}' in parents and trashed=false`;
        let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,parents)&pageSize=1000`;
        if (pageToken) url += `&pageToken=${pageToken}`;
        const res = await fetch(url, h);
        if (!res.ok) throw new Error('listChildren failed');
        return await res.json();
      };

      const buildTree = async (parentId) => {
        let filesAcc = [];
        let foldersAcc = [];
        let nextPage = null;
        do {
          const res = await listChildren(parentId, nextPage);
          const items = res.files || [];
          for (const it of items) {
            if (it.mimeType === 'application/vnd.google-apps.folder') {
              const subtree = await buildTree(it.id);
              foldersAcc.push({ id: it.id, name: it.name, mimeType: it.mimeType, children: subtree.children, files: subtree.files });
            } else if ((it.name && it.name.toLowerCase().endsWith('.epub')) || it.mimeType === 'application/epub+zip') {
              filesAcc.push(it);
            }
          }
          nextPage = res.nextPageToken;
        } while (nextPage);
        return { children: foldersAcc, files: filesAcc };
      };

      const tree = await buildTree(epubFolder.id);
      setFolderTree({ id: epubFolder.id, name: epubFolder.name || 'epub', children: tree.children, files: tree.files });

      // flat list also for backward compatibility
      const allFiles = [];
      const collect = (node) => {
        if (!node) return;
        if (node.files) allFiles.push(...node.files);
        if (node.children) node.children.forEach(collect);
      };
      collect(tree);
      setFiles(allFiles || []);
    } catch (err) { console.error(err); }
    setLibraryLoading(false);
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

  const normalizeHref = (h) => {
    if (!h) return null;
    try {
      let s = String(h).split('#')[0].split('?')[0];
      s = decodeURIComponent(s);
      const parts = s.split('/');
      let name = parts[parts.length - 1] || s;
      name = name.replace(/\.(x?html|html|xhtml|htm|ncx|xml)$/i, '');
      return name.toLowerCase();
    } catch { return String(h).toLowerCase(); }
  };

  const findPathToHref = (items, targetBase, parentKey = '') => {
    if (!items || !items.length || !targetBase) return null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemKey = `${parentKey}-${i}`;
      const itemHrefRaw = item.href || item.id || item.link || item.target || '';
      const itemBase = normalizeHref(itemHrefRaw);
      if (itemBase && (itemBase === targetBase || targetBase.includes(itemBase) || itemBase.includes(targetBase))) {
        return [itemKey];
      }
      const children = getChildren(item) || [];
      const sub = findPathToHref(children, targetBase, itemKey);
      if (sub) return [itemKey, ...sub];
    }
    return null;
  };

  const tocRef = useRef(null);

  const scrollToKey = (key) => {
    try {
      if (!tocRef?.current || !key) return;
      const el = tocRef.current.querySelector(`[data-key="${key}"]`);
      if (el && typeof el.scrollIntoView === 'function') {
        console.debug('[epub] scrollToKey', key, el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (e) { }
  };

  const toggleExpand = (key) => {
    setExpandedItems(prev => {
      const opening = !prev[key];
      const next = { ...prev, [key]: !prev[key] };
      // schedule scroll if opening and current path is descendant
      setTimeout(() => {
        try {
          if (opening && Array.isArray(currentPath) && currentPath.length) {
            if (currentPath.some(k => k.startsWith(key))) {
              const leaf = currentPath[currentPath.length - 1];
              scrollToKey(leaf);
            }
          }
        } catch (_) {}
      }, 90);
      return next;
    });
  };

  const renderTocItems = (items, level = 0, parentKey = '') => {
    if (!items || !items.length) return null;

    const curBase = normalizeHref(currentHref);
    const baseIndent = 20;
    const indentPerLevel = 24;

    return items.map((item, idx) => {
      const children = getChildren(item) || [];
      const itemKey = `${parentKey}-${idx}`;
      const isExpanded = expandedItems[itemKey];
      const label = (item.label && (item.label.text || item.label)) || item.title || item.text || item.href || item.id || 'Untitled';
      const hasChildren = children.length > 0 && level < 3;

      const itemHrefRaw = item.href || item.id || item.link || item.target || '';
      const itemBase = normalizeHref(itemHrefRaw);
      const isActiveLeaf = Array.isArray(currentPath) && currentPath[currentPath.length - 1] === itemKey;
      const isAncestor = Array.isArray(currentPath) && currentPath.includes(itemKey);
      const isCurrent = isActiveLeaf || isAncestor || (curBase && itemBase && (curBase === itemBase || curBase.includes(itemBase) || itemBase.includes(curBase)));

      const paddingLeft = `${baseIndent + Math.min(level, 3) * indentPerLevel}px`;

      return (
        <li key={itemKey} data-key={itemKey} style={{ marginBottom: '6px', paddingLeft }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
                  width: '18px',
                }}
                aria-expanded={!!isExpanded}
                aria-controls={`toc-${itemKey}`}
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            )}
            <button
              data-key={itemKey}
              data-active={isActiveLeaf ? '1' : undefined}
              onClick={() => renditionRef.current && renditionRef.current.display(item.href || item.id || item.link || item.target)}
              style={{
                background: isActiveLeaf ? 'rgba(22,163,74,0.30)' : (isAncestor ? 'rgba(22,163,74,0.18)' : 'transparent'),
                border: 'none',
                padding: isActiveLeaf ? '8px 10px' : '6px 8px',
                textAlign: 'left',
                color: isActiveLeaf || isAncestor ? '#ffffff' : c.tocText,
                cursor: 'pointer',
                fontSize: '0.9rem',
                flex: 1,
                borderLeft: isActiveLeaf ? `4px solid ${c.accent}` : (isAncestor ? `3px solid ${c.accent}` : 'none'),
                borderRadius: isActiveLeaf ? '8px' : (isAncestor ? '6px' : undefined),
                fontWeight: isActiveLeaf ? 700 : undefined,
              }}
            >
              {label}
            </button>
          </div>
          {hasChildren && isExpanded && (
            <ul id={`toc-${itemKey}`} style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {renderTocItems(children, level + 1, itemKey)}
            </ul>
          )}
        </li>
      );
    });
  };

  useEffect(() => {
    // compute path to current chapter in toc (array of keys)
    try {
      if (!toc || !toc.length) { setCurrentPath([]); return; }
      const targetBase = normalizeHref(currentHref);
      const path = findPathToHref(toc, targetBase) || [];
      console.debug('[epub] computePath', { targetBase, path, tocLen: toc?.length });
      setCurrentPath(path);
    } catch (e) { setCurrentPath([]); }
  }, [toc, currentHref]);

  useEffect(() => {
    if (!tocOpen) return;
    if (Array.isArray(currentPath) && currentPath.length) {
      // expand ancestors so active item is visible
      setExpandedItems(prev => {
        const next = { ...prev };
        for (let i = 0; i < currentPath.length - 1; i++) next[currentPath[i]] = true;
        return next;
      });
      // scroll to leaf
      setTimeout(() => {
        try {
          const leaf = currentPath[currentPath.length - 1] || currentPath[0];
          scrollToKey(leaf);
        } catch (_) {}
      }, 100);
    } else {
      if (tocRef?.current) tocRef.current.scrollTop = 0;
    }
  }, [tocOpen, currentPath]);

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
        try { iframe.sandbox = 'allow-same-origin allow-scripts'; } catch (_) {}
        try { iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts'); } catch (_) {}
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
        @import url('https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@300;400;600;700&display=swap');
        html {
          background: ${bg} !important;
          overflow: hidden !important;   /* iframe không tự cuộn */
          border: none !important;
        }
        body {
          background: ${bg} !important;
          color: ${color} !important;
          font-family: 'Nunito Sans', sans-serif !important;
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
        try {
          const loc = (typeof rendition.currentLocation === 'function') ? rendition.currentLocation() : location;
          const href = (loc && loc.start && loc.start.href) || loc?.href || (location && location.start && location.start.href) || null;
          if (href) {
            setCurrentHref(href);
            try {
              const targetBase = normalizeHref(href);
              const path = findPathToHref(toc, targetBase) || [];
              console.debug('[epub] relocated href', href, '-> path', path, 'tocLen', toc?.length);
              if (path && path.length) {
                setCurrentPath(path);
                // expand ancestors so the active item is visible
                setExpandedItems(prev => {
                  const next = { ...prev };
                  for (let i = 0; i < path.length - 1; i++) next[path[i]] = true;
                  return next;
                });
                if (tocOpen && tocRef?.current) {
                  setTimeout(() => { try { scrollToKey(path[path.length - 1]); } catch (_) {} }, 120);
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
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

      // initial highlight/expand TOC based on current location
      try {
        const loc = (typeof rendition.currentLocation === 'function') ? rendition.currentLocation() : null;
        const href = (loc && loc.start && loc.start.href) || loc?.href || null;
        if (href) {
          setCurrentHref(href);
          try {
            const targetBase = normalizeHref(href);
            const path = findPathToHref(toc, targetBase) || [];
            if (path && path.length) {
              setCurrentPath(path);
              setExpandedItems(prev => {
                const next = { ...prev };
                for (let i = 0; i < path.length - 1; i++) next[path[i]] = true;
                return next;
              });
              setTimeout(() => { try { scrollToKey(path[path.length - 1]); } catch (_) {} }, 120);
            }
          } catch (_) {}
        }
      } catch (_) {}

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
    fontSize: '0.82rem', fontFamily: "'Nunito Sans', sans-serif", fontWeight: 500,
  };

  // Get current folder based on path
  const getCurrentFolder = () => {
    if (!folderTree) return null;
    let current = folderTree;
    for (const folderId of currentFolderPath) {
      if (current.children) {
        const found = current.children.find(c => c.id === folderId);
        if (found) current = found;
        else return current;
      } else return current;
    }
    return current;
  };

  // Navigate into folder (grid)
  const enterFolder = (folderId) => {
    setCurrentFolderPath(prev => [...prev, folderId]);
  };

  // Go back to parent folder (grid)
  const exitFolder = () => {
    setCurrentFolderPath(prev => (prev.length > 0 ? prev.slice(0, -1) : prev));
  };

  // Render grid layout for library
  const renderGridLibrary = () => {
    const currentFolder = getCurrentFolder();
    if (!currentFolder) return null;

    const items = [];
    if (currentFolder.children) {
      items.push(...currentFolder.children.map(folder => ({ type: 'folder', data: folder })));
    }
    if (currentFolder.files) {
      items.push(...currentFolder.files.map(file => ({ type: 'file', data: file })));
    }

    return (
      <div>
        {/* Breadcrumb */}
        {currentFolderPath.length > 0 && (
          <div style={{ marginBottom: '14px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => setCurrentFolderPath([])} style={{ ...btn, background: 'transparent', border: `1px solid ${c.border}`, color: c.accent }}>← {folderTree.name}</button>
            {currentFolderPath.map((folderId, idx) => {
              const folder = (() => {
                let current = folderTree;
                for (let i = 0; i <= idx; i++) {
                  if (current.children) {
                    const found = current.children.find(c => c.id === currentFolderPath[i]);
                    if (found) current = found;
                  }
                }
                return current;
              })();
              return (
                <div key={folderId} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: c.sub }}>/</span>
                  <span style={{ color: c.accent }}>{folder?.name || '?'}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '16px' }}>
          {items.map(item => (
            <div
              key={item.data.id}
              onClick={() => {
                if (item.type === 'folder') {
                  enterFolder(item.data.id);
                } else {
                  openBook(item.data.id);
                }
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '10px',
                padding: '16px 12px',
                backgroundColor: c.surface,
                border: `1px solid ${c.border}`,
                borderRadius: '10px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                fontSize: '0.85rem',
                textAlign: 'center',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = c.border;
                e.currentTarget.style.transform = 'scale(1.05)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = c.surface;
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              <div style={{ fontSize: '3rem' }}>{item.type === 'folder' ? '📁' : '📖'}</div>
              <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>
                {item.type === 'folder' ? item.data.name : item.data.name.replace('.epub', '')}
              </div>
              {item.type === 'folder' && item.data.children && (
                <div style={{ fontSize: '0.75rem', color: c.sub }}>
                  {item.data.children.length} thư mục
                </div>
              )}
              {item.type === 'folder' && item.data.files && (
                <div style={{ fontSize: '0.75rem', color: c.sub }}>
                  {item.data.files.length} sách
                </div>
              )}
            </div>
          ))}
        </div>

        {items.length === 0 && (
          <div style={{ textAlign: 'center', color: c.sub, padding: '40px 20px' }}>
            Thư mục trống
          </div>
        )}
      </div>
    );
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
        flexWrap: 'nowrap',
        minHeight: '44px',
      }}>
        <span onClick={goBack} style={{ cursor: 'pointer', color: c.accent, fontWeight: 700, fontSize: '0.98rem', userSelect: 'none', flexShrink: 0, whiteSpace: 'nowrap' }}>
          📚 EPUB READER
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap', flexShrink: 0 }}>
          {currentBook && <>
            <button style={btn} onClick={() => changeFontSize(-10)}>A−</button>
            <button style={btn} onClick={() => changeFontSize(10)}>A+</button>
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
          {libraryLoading && <p style={{ color: c.sub, fontSize: '0.88rem' }}>Đang tải thư viện...</p>}
          {!libraryLoading && folderTree && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 600, color: c.sub }}>📁 Thư viện</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button style={btn} onClick={() => fetchFiles()}>Tải lại</button>
                </div>
              </div>
              {renderGridLibrary()}
            </div>
          )}
          {!libraryLoading && !folderTree && !loading && <p style={{ color: c.sub, fontSize: '0.88rem' }}>Không tìm thấy file .epub trong thư mục epub</p>}
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
              <div ref={tocRef} style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: '300px',
                borderRight: `1px solid ${c.border}`,
                backgroundColor: c.surface,
                overflowY: 'auto',
                padding: 0,
                boxSizing: 'border-box',
              }}>
                <div style={{ position: 'sticky', top: 0, zIndex: 1000, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderBottom: `1px solid ${c.border}`, background: c.surface }}>
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