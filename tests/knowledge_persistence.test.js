'use strict';
/**
 * knowledge_persistence.test.js — instructors and class descriptions saved from the knowledge panel are written
 * under DATA_DIR (the persistent volume in production) and are read back from there after a restart.
 *
 * Production, 2026-11-17: the repository's data/ folder is not part of a deployment, so /app/data did not exist;
 * the agent started without instructors and classes, and a save from the panel failed with ENOENT.
 * All data here is invented.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');

jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const STAFF   = { instructors: [{ name_he: 'מדריכת בדיקה', specialties: ['רפורמר'] }] };
const CLASSES = { classes: [{ name: 'שיעור בדיקה', description: 'תיאור בדיקה' }], _universal_access: '' };

describe('knowledge saved from the panel survives a restart', () => {
  let dir;
  beforeEach(() => {
    // a DATA_DIR that does not exist yet, as on a first save in production
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shape-knowledge-')), 'volume');
    process.env.DATA_DIR = dir;
    jest.resetModules();
  });
  afterEach(() => { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); });

  test('with nothing saved the agent starts with empty knowledge, without throwing', () => {
    const agent = require('../agents/barak_agent');
    const k = agent.getRawKnowledge();
    expect(k.staff.instructors).toEqual([]);
    expect(k.classes.classes).toEqual([]);
  });

  test('a save creates the folder, writes under DATA_DIR and is used at once', () => {
    const agent = require('../agents/barak_agent');
    agent.reloadKnowledge({ staffData: STAFF });
    agent.reloadKnowledge({ classesData: CLASSES });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'staff_directory.json'), 'utf8'))).toEqual(STAFF);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'classes_knowledge.json'), 'utf8'))).toEqual(CLASSES);
    expect(agent.getRawKnowledge().contexts.staff).toContain('מדריכת בדיקה');
  });

  test('after a restart the saved knowledge is loaded from DATA_DIR', () => {
    require('../agents/barak_agent').reloadKnowledge({ staffData: STAFF, classesData: CLASSES });
    jest.resetModules();
    const k = require('../agents/barak_agent').getRawKnowledge();
    expect(k.staff).toEqual(STAFF);
    expect(k.classes.classes).toEqual(CLASSES.classes);
  });
});
