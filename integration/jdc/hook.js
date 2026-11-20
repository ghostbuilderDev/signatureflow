  // [JDC_SIGNATUREFLOW_V3]
  window.JournalSignatureFlow?.create({
    getClient: () => app.db,
    getState: () => ({user: app.user, chantierId: app.currentId, siteName: currentChantier()?.name,
      folders: app.documentFolders, documents: app.documents, folderId: app.documentViewFolderId,
      canManage: canManageDocuments(), cloud: isCloudReady()}),
    get supabaseUrl() { return CONFIG.SUPABASE_URL; },
    get publicKey() { return CONFIG.SUPABASE_ANON_KEY; },
    onRefresh: () => refreshCloudCurrent()
  });
  // [/JDC_SIGNATUREFLOW_V3]
