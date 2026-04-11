# TubeGrab Download Fix Progress

## Plan Steps
- [ ] 1. Verify dependencies (package.json, ffmpeg)
- [ ] 2. Edit server.js: Remove DOWNLOAD_DIR/fs logic, implement yt-dlp stdout pipe to res
- [ ] 3. Test single download (no disk files created)
- [ ] 4. Test multiple concurrent downloads (open multiple tabs)
- [ ] 5. Frontend progress polish (optional)
- [ ] 6. Cleanup: remove unused code
- [ ] 7. Verify no temp files, concurrent works

**Current:** Starting step 1.
