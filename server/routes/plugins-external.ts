import { Router } from 'express';
import { db } from '../db';
import { config } from '../config';
import path from 'path';
import fs from 'fs';
import JSZip from 'jszip';
import express from 'express';

const router = Router();
const PLUGINS_DIR = path.join(config.dataDir, 'plugins');

// Ensure directory exists
if (!fs.existsSync(PLUGINS_DIR)) {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

/**
 * List all side-loaded plugins found on disk.
 */
router.get('/external', (req, res) => {
  if (!fs.existsSync(PLUGINS_DIR)) return res.json([]);
  
  const plugins = [];
  const dirs = fs.readdirSync(PLUGINS_DIR);

  for (const dir of dirs) {
    const manifestPath = path.join(PLUGINS_DIR, dir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        plugins.push({
          ...manifest,
          dir
        });
      } catch (e) {
        console.error(`Failed to read manifest for plugin ${dir}:`, e);
      }
    }
  }

  res.json(plugins);
});

/**
 * Install a plugin from a ZIP upload.
 */
router.post('/install', express.raw({ type: 'application/zip', limit: '50mb' }), async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });

  const buf = req.body;
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'Empty ZIP file' });

  try {
    const zip = await JSZip.loadAsync(buf);
    
    // 1. Find the manifest to get the plugin ID
    const manifestFile = Object.keys(zip.files).find(f => f.endsWith('manifest.json'));
    if (!manifestFile) {
      return res.status(400).json({ error: 'Invalid plugin: manifest.json not found' });
    }

    const manifestContent = await zip.files[manifestFile].async('string');
    const manifest = JSON.parse(manifestContent);
    const pluginId = manifest.id;

    if (!pluginId || !/^[a-z0-9._-]+$/.test(pluginId)) {
      return res.status(400).json({ error: 'Invalid plugin ID in manifest' });
    }

    const targetDir = path.join(PLUGINS_DIR, pluginId);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 2. Extract all files
    // If the zip has a root folder, we flatten it
    const hasRootFolder = manifestFile.includes('/');
    const rootPrefix = hasRootFolder ? manifestFile.split('/')[0] + '/' : '';

    for (const [filename, file] of Object.entries(zip.files)) {
      if (file.dir) continue;

      let relativePath = filename;
      if (hasRootFolder && filename.startsWith(rootPrefix)) {
        relativePath = filename.slice(rootPrefix.length);
      }
      
      if (!relativePath) continue;

      const dest = path.join(targetDir, relativePath);
      const destDir = path.dirname(dest);
      
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      const content = await file.async('nodebuffer');
      fs.writeFileSync(dest, content);
    }

    res.json({ success: true, pluginId, name: manifest.name });
  } catch (err: any) {
    console.error('Plugin installation failed:', err);
    res.status(500).json({ error: `Installation failed: ${err.message}` });
  }
});

/**
 * Delete an external plugin.
 */
router.delete('/:id', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  
  const { id } = req.params;
  const targetDir = path.join(PLUGINS_DIR, id);

  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Plugin not found' });
  }
});

export default router;
