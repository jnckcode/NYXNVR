/**
 * @file api.js
 * @description Frontend REST API client module wrapping all Antigravity NVR backend endpoints.
 * @functions API (getCameras, createCamera, updateCamera, toggleCamera, toggleAI, updateROI, deleteCamera, discoverCameras, getSettings, updateSettings, uploadModel, getRecordings, getEvents, getSystemMetrics, getDiskMetrics)
 * @dependencies none
 */

const API = {
  async getCameras() {
    const res = await fetch('/api/v1/cameras');
    return res.json();
  },

  async getCamera(id) {
    const res = await fetch(`/api/v1/cameras/${id}`);
    return res.json();
  },

  async createCamera(data) {
    const res = await fetch('/api/v1/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async updateCamera(id, data) {
    const res = await fetch(`/api/v1/cameras/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async toggleCamera(id, enabled) {
    const res = await fetch(`/api/v1/cameras/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    return res.json();
  },

  async toggleAI(id, ai_enabled) {
    const res = await fetch(`/api/v1/cameras/${id}/toggle-ai`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_enabled })
    });
    return res.json();
  },

  async updateROI(id, roiConfig) {
    const res = await fetch(`/api/v1/cameras/${id}/roi`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roi_config: roiConfig })
    });
    return res.json();
  },

  async deleteCamera(id) {
    const res = await fetch(`/api/v1/cameras/${id}`, {
      method: 'DELETE'
    });
    return res.json();
  },

  async discoverCameras(timeout = 3500) {
    const res = await fetch(`/api/v1/cameras/discover?timeout=${timeout}`);
    return res.json();
  },

  async getSettings() {
    const res = await fetch('/api/v1/settings');
    return res.json();
  },

  async updateSettings(settings) {
    const res = await fetch('/api/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    return res.json();
  },

  async getRetentionStatus() {
    const res = await fetch('/api/v1/storage/retention-status');
    return res.json();
  },

  async triggerPurge() {
    const res = await fetch('/api/v1/storage/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return res.json();
  },

  async uploadModel(file) {
    const formData = new FormData();
    formData.append('model', file);
    const res = await fetch('/api/v1/models/upload', {
      method: 'POST',
      body: formData
    });
    return res.json();
  },

  async getRecordings(filter = {}) {
    const params = new URLSearchParams();
    if (filter.cameraId) params.append('cameraId', filter.cameraId);
    if (filter.startDate) params.append('startDate', filter.startDate);
    if (filter.endDate) params.append('endDate', filter.endDate);
    if (filter.limit) params.append('limit', filter.limit);
    if (filter.offset) params.append('offset', filter.offset);

    const res = await fetch(`/api/v1/recordings?${params.toString()}`);
    return res.json();
  },

  async getEvents(filter = {}) {
    const params = new URLSearchParams();
    if (filter.cameraId) params.append('cameraId', filter.cameraId);
    if (filter.label) params.append('label', filter.label);
    if (filter.minConfidence !== undefined && filter.minConfidence !== '') params.append('minConfidence', filter.minConfidence);
    if (filter.startDate) params.append('startDate', filter.startDate);
    if (filter.endDate) params.append('endDate', filter.endDate);
    if (filter.limit !== undefined) params.append('limit', filter.limit);
    if (filter.offset !== undefined) params.append('offset', filter.offset);

    const res = await fetch(`/api/v1/events?${params.toString()}`);
    return res.json();
  },

  async getSystemMetrics() {
    const res = await fetch('/api/v1/system/metrics');
    return res.json();
  },

  async getDiskMetrics() {
    const res = await fetch('/api/v1/system/disk');
    return res.json();
  },

  async getGovernorMetrics() {
    const res = await fetch('/api/v1/system/governor');
    return res.json();
  },

  async getAvailableModels() {
    const res = await fetch('/api/v1/models');
    return res.json();
  },

  async selectModel(modelPath) {
    const res = await fetch('/api/v1/models/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath })
    });
    return res.json();
  }
};
