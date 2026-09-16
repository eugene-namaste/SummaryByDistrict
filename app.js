(async function () {
  "use strict";

  const configResponse = await fetch("./config.yaml", { cache: "no-store" });
  if (!configResponse.ok) {
    throw new Error(`Unable to load config.yaml (${configResponse.status})`);
  }

  const yamlText = await configResponse.text();
  const config = jsyaml.load(yamlText);

  document.title = config.app?.title || "Incident Viewer";

  const headerTitle = document.querySelector("#header h1");
  const headerSubtitle = document.querySelector("#header .subtitle");

  if (headerTitle) headerTitle.textContent = config.app?.title || "Incident Viewer";
  if (headerSubtitle) headerSubtitle.textContent = config.app?.subtitle || "";

  require([
    "esri/Map",
    "esri/views/MapView",
    "esri/layers/FeatureLayer",
    "esri/Graphic"
  ], (ArcGISMap, MapView, FeatureLayer, Graphic) => {

    const layer = new FeatureLayer({
      url: config.data.service_url,
      outFields: ["*"],
      popupTemplate: buildPopupTemplate(config),
      renderer: buildRenderer(config)
    });

    // Separate lookup layer used only to populate filter choices.
    // Keeping this independent from layer.definitionExpression prevents an
    // already-applied incident filter from incorrectly limiting cascade values.
    const filterLookupLayer = new FeatureLayer({
      url: config.data.service_url,
      outFields: ["*"]
    });

    const geographyConfig = config.geography || config.community || {};
    const polygonStyle = geographyConfig.polygon_style || {};
    const selectedPolygonStyle = geographyConfig.selected_polygon_style || {};

    function hexToRgba(hex, opacity, fallback) {
      const value = String(hex || "").trim().replace(/^#/, "");
      const normalized = value.length === 3 ? value.split("").map(ch => ch + ch).join("") : value;
      if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return fallback;
      return [
        parseInt(normalized.slice(0, 2), 16),
        parseInt(normalized.slice(2, 4), 16),
        parseInt(normalized.slice(4, 6), 16),
        opacity
      ];
    }

    function polygonSymbol(style, defaults) {
      return {
        type: "simple-fill",
        color: hexToRgba(style.fill_color, style.fill_opacity ?? defaults.fillOpacity, defaults.fill),
        outline: {
          color: hexToRgba(style.outline_color, style.outline_opacity ?? defaults.outlineOpacity, defaults.outline),
          width: style.outline_width ?? defaults.width
        }
      };
    }

    const geographyLayer = geographyConfig.service_url
      ? new FeatureLayer({
          url: geographyConfig.service_url,
          outFields: ["*"],
          renderer: {
            type: "simple",
            symbol: polygonSymbol(polygonStyle, {
              fillOpacity: 0.04,
              outlineOpacity: 0.55,
              width: 0.8,
              fill: [0, 122, 194, 0.04],
              outline: [0, 122, 194, 0.55]
            })
          }
        })
      : null;

    const map = new ArcGISMap({
      basemap: config.map?.basemap || "streets-navigation-vector",
      layers: geographyLayer ? [geographyLayer, layer] : [layer]
    });

    const view = new MapView({
      container: "viewDiv",
      map,
      center: config.map?.initial_center || [-157.7, 20.8],
      zoom: config.map?.initial_zoom ?? 7,
      popup: {
        dockEnabled: true,
        dockOptions: {
          buttonEnabled: false,
          position: "top-right"
        }
      }
    });


    let selectedGeographyGraphic = null;

    function drawSelectedGeography(feature) {
      // Purely visual overlay. It never changes the geography FeatureLayer renderer
      // and is intentionally called only after counts/charts finish updating.
      if (selectedGeographyGraphic) {
        view.graphics.remove(selectedGeographyGraphic);
        selectedGeographyGraphic = null;
      }
      if (!feature?.geometry) return;

      selectedGeographyGraphic = new Graphic({
        geometry: feature.geometry,
        symbol: polygonSymbol(selectedPolygonStyle, {
          fillOpacity: 0.04,
          outlineOpacity: 0.85,
          width: 1.6,
          fill: [0, 122, 194, 0.04],
          outline: [0, 122, 194, 0.85]
        })
      });
      view.graphics.add(selectedGeographyGraphic);
    }

    const filtersEl = document.getElementById("filters");
    const listEl = document.getElementById("incidentList");
    const resultCount = document.getElementById("resultCount");
    const downloadCsvBtn = document.getElementById("downloadCsvBtn");
    const statusEl = document.getElementById("status");
    const lastUpdateEl = document.getElementById("lastUpdate");
    const totalRecordsEl = document.getElementById("totalRecords");
    const geographySummaryEl = document.getElementById("geographySummary");
    const geographySummaryTitleEl = document.getElementById("geographySummaryTitle");
    if (geographySummaryTitleEl) {
      geographySummaryTitleEl.textContent = geographyConfig.summary_title || "Geographic Summary of Incidents";
    }

    const filterControls = new globalThis.Map();
    let currentFeatures = [];
    let highlightHandle = null;
    let geographyControl = null;
    let selectedGeographyFeature = null;
    
    if (downloadCsvBtn) downloadCsvBtn.addEventListener("click", downloadFilteredCsv);

    async function fetchJson(url) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const json = await response.json();
      if (json?.error) {
        throw new Error(json.error.message || "ArcGIS REST request failed");
      }
      return json;
    }

    async function loadPublicationStatus() {
      try {
        const baseUrl = String(config.data.service_url || "").replace(/\/$/, "");
        const metadataUrl = `${baseUrl}?f=json`;
        const countUrl = `${baseUrl}/query?where=1%3D1&returnCountOnly=true&f=json`;

        const [metadata, countResult] = await Promise.all([
          fetchJson(metadataUrl),
          fetchJson(countUrl)
        ]);

        const count = Number(countResult?.count);
        totalRecordsEl.textContent = Number.isFinite(count)
          ? count.toLocaleString()
          : "Not available";

        const lastEdit =
          metadata?.editingInfo?.lastEditDate ??
          metadata?.lastEditDate ??
          metadata?.dataLastEditDate ??
          null;

        lastUpdateEl.textContent = lastEdit ? formatDate(lastEdit) : "Not available";
      } catch (err) {
        console.error("Unable to load publication status", err);
        lastUpdateEl.textContent = "Unavailable";
        totalRecordsEl.textContent = "Unavailable";
      }
    }

    function buildMarkerSymbol(symbolConfig = {}) {
      return {
        type: "simple-marker",
        style: symbolConfig.style || "circle",
        size: symbolConfig.size ?? 7,
        color: symbolConfig.color || "#808080",
        outline: {
          color: symbolConfig.outline_color || "#ffffff",
          width: symbolConfig.outline_width ?? 0.5
        }
      };
    }

    function buildRenderer(cfg) {
      const rendererConfig = cfg.map?.renderer;

      // No YAML renderer configured:
      // use the renderer already defined on the hosted layer.
      if (!rendererConfig) {
        return undefined;
      }

      if (rendererConfig.type === "simple") {
        return {
          type: "simple",
          symbol: buildMarkerSymbol(
            rendererConfig.symbol || rendererConfig.default_symbol
          )
        };
      }

      if (rendererConfig.type === "unique_value") {
        if (!rendererConfig.field) {
          console.warn(
            "Unique-value renderer requires map.renderer.field. " +
            "Falling back to the hosted layer renderer."
          );
          return undefined;
        }

        const defaultConfig = rendererConfig.default_symbol || {};

        return {
          type: "unique-value",
          field: rendererConfig.field,
          defaultSymbol: buildMarkerSymbol(defaultConfig),
          defaultLabel: defaultConfig.label || "Other",
          uniqueValueInfos: (rendererConfig.values || []).map(item => ({
            value: item.value,
            label: item.label || String(item.value),
            symbol: buildMarkerSymbol(item)
          }))
        };
      }

      console.warn(
        `Unsupported renderer type: ${rendererConfig.type}. ` +
        "Using the hosted layer renderer."
      );

      return undefined;
    }

    function buildPopupTemplate(cfg) {
      const details = cfg.details || {};
      return {
        title: details.title_template || "Incident",
        content: [{
          type: "fields",
          fieldInfos: (details.fields || []).map(item => {
            const info = {
              fieldName: item.field,
              label: item.label || item.field
            };

            if (item.type === "date") {
              info.format = { dateFormat: "short-date-short-time" };
            }

            if (item.type === "date_only") {
              info.format = { dateFormat: "short-date" };
            }

            return info;
          })
        }]
      };
    }

    function sqlEscape(value) {
      return String(value).replace(/'/g, "''");
    }

    function selectedValues(selectElement) {
      return Array.from(selectElement.selectedOptions).map(o => o.value);
    }

    function formatDate(value) {
      if (!value) return "—";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";

      return d.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    }

    function formatDateOnly(value) {
      if (!value) return "—";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";

      return d.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric"
      });
    }

    function safeText(value) {
      if (value === null || value === undefined || value === "") return "—";
      return String(value);
    }

    function dateSql(fieldName, days) {
      const d = new Date();
      d.setDate(d.getDate() - Number(days));

      const pad = n => String(n).padStart(2, "0");
      const literal =
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      return `${fieldName} >= TIMESTAMP '${literal}'`;
    }

    function inClause(field, values) {
      if (!values.length) return null;
      return `${field} IN (${values.map(v => `'${sqlEscape(v)}'`).join(",")})`;
    }

    function addDaysToIsoDate(isoDate, days) {
      const [year, month, day] = isoDate.split("-").map(Number);
      const d = new Date(Date.UTC(year, month - 1, day));
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    }

    function customDateRangeSql(fieldName, startDate, endDate) {
      const endExclusive = addDaysToIsoDate(endDate, 1);
      return (
        `${fieldName} >= TIMESTAMP '${startDate} 00:00:00' AND ` +
        `${fieldName} < TIMESTAMP '${endExclusive} 00:00:00'`
      );
    }

    function getCustomDateRangeState(filter, control) {
      const startDate = control.start.value;
      const endDate = control.end.value;

      if (!startDate && !endDate) {
        return { active: false };
      }

      if (!startDate || !endDate) {
        throw new Error(`${filter.label || "Incident Date Range"}: enter both start and end dates.`);
      }

      const start = new Date(`${startDate}T00:00:00Z`);
      const end = new Date(`${endDate}T00:00:00Z`);

      if (end < start) {
        throw new Error(`${filter.label || "Incident Date Range"}: end date cannot be before start date.`);
      }

      const maxDays = Number(filter.max_days ?? 15);
      const spanDays = Math.round((end - start) / 86400000);

      if (spanDays > maxDays) {
        throw new Error(`${filter.label || "Incident Date Range"}: range cannot exceed ${maxDays} days.`);
      }

      return { active: true, startDate, endDate };
    }

    function syncDateFilterExclusivity() {
      const customFilters = (config.filters || []).filter(f => f.type === "custom_date_range");
      const customActive = customFilters.some(filter => {
        const control = filterControls.get(filter.id);
        return control && (control.start.value || control.end.value);
      });

      for (const filter of config.filters || []) {
        if (filter.type !== "date_range") continue;
        const control = filterControls.get(filter.id);
        if (control) control.disabled = customActive;
      }
    }

    function createFilterUI() {
      filtersEl.innerHTML = "";

      if (geographyLayer) {
        const block = document.createElement("div");
        block.className = "filter-block";
        const title = document.createElement("div");
        title.className = "filter-title";
        title.textContent = geographyConfig.selector_label || geographyConfig.label || "Geography";
        geographyControl = document.createElement("select");
        geographyControl.id = "geographySelector";
        block.appendChild(title);
        block.appendChild(geographyControl);
        filtersEl.appendChild(block);
      }

      for (const filter of config.filters || []) {
        const block = document.createElement("div");
        block.className = "filter-block";

        const title = document.createElement("div");
        title.className = "filter-title";
        title.textContent = filter.label || filter.field;
        block.appendChild(title);

        let control;

        if (filter.type === "custom_date_range") {
          const wrapper = document.createElement("div");
          wrapper.className = "custom-date-range";

          const start = document.createElement("input");
          start.type = "date";
          start.id = `filter_${filter.id}_start`;
          start.setAttribute("aria-label", `${filter.label || filter.field} start date`);

          const separator = document.createElement("span");
          separator.textContent = " to ";

          const end = document.createElement("input");
          end.type = "date";
          end.id = `filter_${filter.id}_end`;
          end.setAttribute("aria-label", `${filter.label || filter.field} end date`);

          const onDateInput = () => {
            syncDateFilterExclusivity();
            statusEl.textContent = config.behavior?.default_status_text || "Ready";
          };

          start.addEventListener("input", onDateInput);
          end.addEventListener("input", onDateInput);

          wrapper.appendChild(start);
          wrapper.appendChild(separator);
          wrapper.appendChild(end);
          block.appendChild(wrapper);

          control = { start, end, wrapper };
        } else {
          const select = document.createElement("select");
          select.id = `filter_${filter.id}`;
          select.dataset.filterId = filter.id;

          if (filter.type === "date_range") {
            for (const choice of filter.choices || []) {
              const option = document.createElement("option");
              option.value = choice.value;
              option.textContent = choice.label;
              option.selected = Number(choice.value) === Number(filter.default);
              select.appendChild(option);
            }
          } else if (filter.type === "unique_values") {
            if (filter.multiple) {
              select.multiple = true;
            }
          } else {
            console.warn(`Unsupported filter type: ${filter.type}`);
          }

          block.appendChild(select);
          control = select;

          if (filter.type === "unique_values") {
            select.addEventListener("change", async () => {
              try {
                await refreshCascadingChildren(filter.id);
              } catch (err) {
                console.error("Unable to refresh cascading filter", err);
                statusEl.textContent = "Unable to refresh filter values. See browser console for details.";
              }
            });
          }
        }

        if (filter.hint) {
          const hint = document.createElement("div");
          hint.className = "hint";
          hint.textContent = filter.hint;
          block.appendChild(hint);
        }

        filtersEl.appendChild(block);
        filterControls.set(filter.id, control);
      }

      const actions = document.createElement("div");
      actions.id = "filterActions";

      const applyBtn = document.createElement("button");
      applyBtn.id = "applyBtn";
      applyBtn.className = "primary";
      applyBtn.textContent = "Apply Filters";
      applyBtn.addEventListener("click", applyFilters);

      const clearBtn = document.createElement("button");
      clearBtn.id = "clearBtn";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", clearFilters);

      actions.appendChild(applyBtn);
      actions.appendChild(clearBtn);
      filtersEl.appendChild(actions);
    }

    function getFilterById(filterId) {
      return (config.filters || []).find(f => f.id === filterId) || null;
    }

    function cascadeWhere(filter) {
      if (!filter?.cascade_from) return `${filter.field} IS NOT NULL`;

      const parent = getFilterById(filter.cascade_from);
      const parentControl = filterControls.get(filter.cascade_from);

      if (!parent || !parentControl || parent.type !== "unique_values") {
        console.warn(
          `Cascade parent '${filter.cascade_from}' for filter '${filter.id}' was not found.`
        );
        return `${filter.field} IS NOT NULL`;
      }

      const parentValues = selectedValues(parentControl);
      const parentClause = inClause(parent.field, parentValues);

      return parentClause
        ? `${filter.field} IS NOT NULL AND ${parentClause}`
        : `${filter.field} IS NOT NULL`;
    }

    async function loadUniqueFilterValue(filter, { clearSelection = false } = {}) {
      if (!filter || filter.type !== "unique_values") return;

      const select = filterControls.get(filter.id);
      if (!select) return;

      const previousValues = clearSelection ? [] : selectedValues(select);

      const q = filterLookupLayer.createQuery();
      q.where = cascadeWhere(filter);
      q.outFields = [filter.field];
      q.returnGeometry = false;
      q.returnDistinctValues = true;
      q.orderByFields = [filter.field];

      const result = await filterLookupLayer.queryFeatures(q);

      const values = [...new Set(
        result.features
          .map(f => f.attributes[filter.field])
          .filter(v => v !== null && v !== undefined && String(v).trim() !== "")
      )].sort((a, b) => String(a).localeCompare(String(b)));

      const stillSelected = new Set(
        previousValues.filter(v => values.some(candidate => String(candidate) === String(v)))
      );

      select.innerHTML = "";

      for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = stillSelected.has(String(value));
        select.appendChild(option);
      }
    }

    async function refreshCascadingChildren(parentId) {
      const children = (config.filters || []).filter(
        f => f.type === "unique_values" && f.cascade_from === parentId
      );

      for (const child of children) {
        await loadUniqueFilterValue(child, { clearSelection: true });
        await refreshCascadingChildren(child.id);
      }
    }

    async function loadUniqueFilterValues() {
      await filterLookupLayer.load();

      // Load parents/independent filters first, then cascading children.
      const uniqueFilters = (config.filters || []).filter(f => f.type === "unique_values");
      const loaded = new Set();

      async function loadWithParents(filter) {
        if (loaded.has(filter.id)) return;

        if (filter.cascade_from) {
          const parent = getFilterById(filter.cascade_from);
          if (parent?.type === "unique_values") {
            await loadWithParents(parent);
          }
        }

        await loadUniqueFilterValue(filter);
        loaded.add(filter.id);
      }

      for (const filter of uniqueFilters) {
        await loadWithParents(filter);
      }
    }

    function buildWhere() {
      const clauses = [];

      for (const filter of config.filters || []) {
        const control = filterControls.get(filter.id);
        if (!control) continue;

        if (filter.type === "date_range") {
          if (!control.disabled) {
            clauses.push(dateSql(filter.field, control.value));
          }
        }

        if (filter.type === "custom_date_range") {
          const range = getCustomDateRangeState(filter, control);
          if (range.active) {
            clauses.push(customDateRangeSql(filter.field, range.startDate, range.endDate));
          }
        }

        if (filter.type === "unique_values") {
          const values = selectedValues(control);
          const clause = inClause(filter.field, values);
          if (clause) clauses.push(clause);
        }
      }

      return clauses.length ? clauses.join(" AND ") : "1=1";
    }

    function getRequiredFields() {
      const fields = new Set();

      fields.add(layer.objectIdField || "OBJECTID");

      for (const filter of config.filters || []) {
        if (filter.field) fields.add(filter.field);
      }

      for (const item of config.list?.fields || []) {
        if (item.field) fields.add(item.field);
      }

      for (const item of config.details?.fields || []) {
        if (item.field) fields.add(item.field);
      }

      if (config.list?.sort_field) {
        fields.add(config.list.sort_field);
      }

      // KPI/chart calculations run client-side on the fetched features, so their
      // source fields must always be included even when they are not shown in
      // the list, details, or filter controls.
      const kpi = config.kpi || {};
      for (const field of [kpi.fire_filter_field, kpi.category_field, kpi.date_field]) {
        if (field) fields.add(field);
      }

      return [...fields];
    }

    async function fetchAllFilteredFeatures(where, geometry = null) {
      const spatial = geometry ? { geometry, spatialRelationship: "intersects" } : {};
      const objectIds = await layer.queryObjectIds({ where, ...spatial });

      if (!objectIds || objectIds.length === 0) {
        return [];
      }

      const chunkSize = 1000;
      const chunks = [];

      for (let i = 0; i < objectIds.length; i += chunkSize) {
        chunks.push(objectIds.slice(i, i + chunkSize));
      }

      const outFields = getRequiredFields();

      const results = await Promise.all(
        chunks.map(ids => layer.queryFeatures({
          objectIds: ids,
          outFields,
          returnGeometry: true,
          outSpatialReference: view.spatialReference
        }))
      );

      const features = results.flatMap(r => r.features);

      const sortField = config.list?.sort_field;
      const descending =
        String(config.list?.sort_order || "descending").toLowerCase() !== "ascending";

      if (sortField) {
        features.sort((a, b) => {
          const av = a.attributes[sortField];
          const bv = b.attributes[sortField];

          const ad = new Date(av);
          const bd = new Date(bv);

          let result;
          if (!Number.isNaN(ad.getTime()) && !Number.isNaN(bd.getTime())) {
            result = ad - bd;
          } else {
            result = String(av ?? "").localeCompare(String(bv ?? ""));
          }

          return descending ? -result : result;
        });
      }

      return features;
    }

    function findListField(role) {
      return (config.list?.fields || []).find(f => f.role === role);
    }

    function renderList(features) {
      listEl.innerHTML = "";
      resultCount.textContent = features.length.toLocaleString();
      if (downloadCsvBtn) downloadCsvBtn.disabled = features.length === 0;

      if (!features.length) {
        listEl.innerHTML =
          `<div class="empty">${config.behavior?.no_results_text || "No incidents match the current filters."}</div>`;
        return;
      }

      const titleField = findListField("title");
      const addressField = findListField("address");
      const metaFields = (config.list?.fields || []).filter(f => f.role === "meta");
      const dateField = findListField("date");

      const fragment = document.createDocumentFragment();

      for (const feature of features) {
        const a = feature.attributes;
        const oid = a[layer.objectIdField];

        const row = document.createElement("div");
        row.className = "incident";
        row.dataset.objectId = oid;

        const title = titleField ? safeText(a[titleField.field]) : safeText(oid);
        const address = addressField ? safeText(a[addressField.field]) : "";

        const metaLines = metaFields.map(item => safeText(a[item.field]));

        if (dateField) {
          let dateValue;

          if (dateField.type === "date") {
            dateValue = formatDate(a[dateField.field]);
          } else if (dateField.type === "date_only") {
            dateValue = formatDateOnly(a[dateField.field]);
          } else {
            dateValue = safeText(a[dateField.field]);
          }

          metaLines.push(dateValue);
        }

        row.innerHTML = `
          <div class="incident-id">${title}</div>
          ${address ? `<div class="incident-address">${address}</div>` : ""}
          <div class="incident-meta">${metaLines.join("<br>")}</div>
        `;

        row.addEventListener("click", () => selectIncident(feature));
        fragment.appendChild(row);
      }

      listEl.appendChild(fragment);
    }


    function csvEscape(value) {
      if (value === null || value === undefined) return "";
      const text = String(value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function getCsvColumns() {
      // The CSV export uses exactly the fields configured for the incident list,
      // in the same order. Popup/detail and filter fields are intentionally not
      // appended here, so config.list.fields is the single source of truth.
      const columns = [];
      const seen = new Set();

      for (const item of config.list?.fields || []) {
        if (!item.field || seen.has(item.field)) continue;
        seen.add(item.field);
        columns.push({
          field: item.field,
          label: item.label || item.field,
          type: item.type
        });
      }

      return columns;
    }

    function formatCsvValue(value, type) {
      if (value === null || value === undefined) return "";
      if (type === "date_only") {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const day = String(d.getDate()).padStart(2, "0");
          return `${y}-${m}-${day}`;
        }
      }
      if (type === "date") {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
      return value;
    }

    async function downloadFilteredCsv() {
      if (!currentFeatures.length) return;

      const expectedCount = currentFeatures.length;
      const columns = getCsvColumns();
      const oidField = layer.objectIdField || "OBJECTID";
      const outFields = [...new Set([oidField, ...columns.map(c => c.field).filter(Boolean)])];
      const objectIds = currentFeatures
        .map(f => f.attributes?.[oidField])
        .filter(v => v !== null && v !== undefined);

      if (objectIds.length !== expectedCount) {
        statusEl.textContent =
          `CSV export stopped: expected ${expectedCount.toLocaleString()} incidents but only ` +
          `${objectIds.length.toLocaleString()} ObjectIDs were available.`;
        return;
      }

      if (downloadCsvBtn) downloadCsvBtn.disabled = true;
      const originalLabel = downloadCsvBtn ? downloadCsvBtn.textContent : "";
      if (downloadCsvBtn) downloadCsvBtn.textContent = "Preparing CSV...";
      statusEl.textContent = `Preparing ${expectedCount.toLocaleString()} incidents for CSV...`;

      try {
        // Use conservative ObjectID chunks. This avoids relying on resultOffset/resultRecordCount
        // and works even when the service's maxRecordCount changes.
        const chunkSize = 500;
        const exported = [];

        for (let i = 0; i < objectIds.length; i += chunkSize) {
          const ids = objectIds.slice(i, i + chunkSize);
          const result = await layer.queryFeatures({
            objectIds: ids,
            outFields,
            returnGeometry: false
          });
          exported.push(...(result.features || []));
          statusEl.textContent =
            `Preparing CSV: ${Math.min(i + chunkSize, objectIds.length).toLocaleString()} ` +
            `of ${objectIds.length.toLocaleString()} incidents...`;
        }

        // De-duplicate by ObjectID defensively and restore the same order as the on-screen list.
        const byOid = new Map();
        for (const feature of exported) {
          const oid = feature.attributes?.[oidField];
          if (oid !== null && oid !== undefined) byOid.set(String(oid), feature);
        }
        const ordered = objectIds.map(id => byOid.get(String(id))).filter(Boolean);

        // Never silently create a partial export.
        if (ordered.length !== expectedCount) {
          throw new Error(
            `CSV verification failed: screen has ${expectedCount.toLocaleString()} incidents, ` +
            `but ${ordered.length.toLocaleString()} were retrieved for export.`
          );
        }

        const lines = [];
        lines.push(columns.map(c => csvEscape(c.label)).join(","));
        for (const feature of ordered) {
          const attrs = feature.attributes || {};
          lines.push(columns.map(c => csvEscape(formatCsvValue(attrs[c.field], c.type))).join(","));
        }

        const blob = new Blob(["\uFEFF" + lines.join("\r\n")], {
          type: "text/csv;charset=utf-8"
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const now = new Date();
        const stamp = [
          now.getFullYear(),
          String(now.getMonth() + 1).padStart(2, "0"),
          String(now.getDate()).padStart(2, "0")
        ].join("");

        link.href = url;
        link.download = `FireServiceIncidents_${stamp}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        statusEl.textContent =
          `${ordered.length.toLocaleString()} filtered incident` +
          `${ordered.length === 1 ? "" : "s"} downloaded (verified).`;
      } catch (error) {
        console.error("CSV export failed", error);
        statusEl.textContent = error?.message || "CSV export failed.";
      } finally {
        if (downloadCsvBtn) {
          downloadCsvBtn.disabled = currentFeatures.length === 0;
          downloadCsvBtn.textContent = originalLabel || "Download CSV";
        }
      }
    }

    async function selectIncident(feature) {
      const oid = feature.attributes[layer.objectIdField];

      document.querySelectorAll(".incident").forEach(el => {
        el.classList.toggle("selected", Number(el.dataset.objectId) === Number(oid));
      });

      try {
        await view.goTo({
          target: feature.geometry,
          zoom: config.map?.selection_zoom ?? 16
        }, {
          duration: 700
        });
      } catch (e) {
        if (e.name !== "AbortError") console.error(e);
      }

      await view.openPopup({
        features: [feature],
        location: feature.geometry
      });

      if (config.behavior?.selection_highlight !== false) {
        const layerView = await view.whenLayerView(layer);

        if (highlightHandle) {
          highlightHandle.remove();
        }

        highlightHandle = layerView.highlight(feature);
      }
    }

    async function zoomToFilteredExtent(where, geometry = null) {
      const spatial = geometry ? { geometry, spatialRelationship: "intersects" } : {};
      const extentResult = await layer.queryExtent({ where, ...spatial });

      if (!extentResult.extent) return;

      try {
        if (extentResult.count === 1) {
          const only = currentFeatures[0];

          if (only?.geometry) {
            await view.goTo({
              target: only.geometry,
              zoom: config.map?.selection_zoom ?? 16
            }, {
              duration: 650
            });
          }
        } else {
          const factor = config.map?.extent_expand_factor ?? 1.15;
          await view.goTo(extentResult.extent.expand(factor), { duration: 650 });
        }
      } catch (e) {
        if (e.name !== "AbortError") console.error(e);
      }
    }

    function getGeographyDisplayFields() {
      const configured = Array.isArray(geographyConfig.display_fields)
        ? geographyConfig.display_fields.filter(item => item?.field)
        : [];

      if (configured.length) return configured;

      // Backward compatibility with the first Community KPI configuration.
      const fallback = [];
      if (geographyConfig.selector_field) {
        fallback.push({
          field: geographyConfig.selector_field,
          label: geographyConfig.selector_label || geographyConfig.label || geographyConfig.selector_field
        });
      }
      if (geographyConfig.risk_field) {
        fallback.push({ field: geographyConfig.risk_field, label: geographyConfig.risk_label || geographyConfig.risk_field });
      }
      if (geographyConfig.zone_field) {
        fallback.push({ field: geographyConfig.zone_field, label: geographyConfig.zone_label || geographyConfig.zone_field });
      }
      return fallback;
    }

    async function loadGeographies() {
      if (!geographyLayer || !geographyControl) return;
      await geographyLayer.load();

      const selectorField = geographyConfig.selector_field;
      if (!selectorField) throw new Error("geography.selector_field is required.");

      const oidField = geographyLayer.objectIdField;
      const outFields = [...new Set([
        oidField,
        selectorField,
        ...getGeographyDisplayFields().map(item => item.field)
      ].filter(Boolean))];

      const result = await geographyLayer.queryFeatures({
        where: geographyConfig.where || "1=1",
        outFields,
        returnGeometry: false,
        orderByFields: [`${selectorField} ASC`]
      });

      geographyControl.innerHTML = "";
      const all = document.createElement("option");
      all.value = "";
      all.textContent = geographyConfig.all_label || `All ${geographyConfig.label || "Geographies"}`;
      geographyControl.appendChild(all);

      for (const feature of result.features) {
        const label = feature.attributes?.[selectorField];
        const oid = feature.attributes?.[oidField];
        if (label == null || oid == null) continue;
        const option = document.createElement("option");
        option.value = String(oid);
        option.textContent = String(label);
        geographyControl.appendChild(option);
      }
    }

    async function getSelectedGeography() {
      if (!geographyLayer || !geographyControl?.value) return null;

      await geographyLayer.load();
      const oidField = geographyLayer.objectIdField;
      const oid = Number(geographyControl.value);
      const displayFields = getGeographyDisplayFields();
      const outFields = [...new Set([
        oidField,
        geographyConfig.selector_field,
        ...displayFields.map(item => item.field)
      ].filter(Boolean))];

      const result = await geographyLayer.queryFeatures({
        objectIds: [oid],
        outFields,
        returnGeometry: true,
        outSpatialReference: view.spatialReference
      });
      return result.features[0] || null;
    }

    function renderGeographySummary(geographyFeature, fireCount) {
      if (!geographySummaryEl) return;
      geographySummaryEl.replaceChildren();

      const addCard = (label, value) => {
        const card = document.createElement("div");
        card.className = "kpi-card";
        const labelEl = document.createElement("div");
        labelEl.className = "kpi-label";
        labelEl.textContent = label;
        const valueEl = document.createElement("div");
        valueEl.className = "kpi-value";
        valueEl.textContent = value == null || value === "" ? "—" : String(value);
        card.append(labelEl, valueEl);
        geographySummaryEl.appendChild(card);
      };

      addCard(config.kpi?.count_label || "Fire Incidents", Number(fireCount || 0).toLocaleString());

      const fields = getGeographyDisplayFields();
      if (geographyFeature) {
        for (const item of fields) {
          addCard(item.label || item.field, safeText(geographyFeature.attributes?.[item.field]));
        }
      } else {
        const selectorLabel = geographyConfig.selector_label || geographyConfig.label || "Geography";
        addCard(selectorLabel, geographyConfig.all_label || `All ${geographyConfig.label || "Geographies"}`);
        for (const item of fields) {
          if (item.field === geographyConfig.selector_field) continue;
          addCard(item.label || item.field, "—");
        }
      }
    }

    function renderCategoryBars(categories) {
      const el = document.getElementById("categoryChart");
      if (!el) return;
      el.replaceChildren();
      if (!categories.length) {
        const empty = document.createElement("div");
        empty.className = "chart-empty";
        empty.textContent = "No fire incidents for the current selection.";
        el.appendChild(empty);
        return;
      }
      const max = Math.max(...categories.map(([, count]) => Number(count) || 0), 1);
      for (const [label, count] of categories) {
        const row = document.createElement("div");
        row.className = "hbar-row";

        const labelEl = document.createElement("div");
        labelEl.className = "hbar-label";
        labelEl.title = label;
        labelEl.textContent = label;

        const track = document.createElement("div");
        track.className = "hbar-track";
        const fill = document.createElement("div");
        fill.className = "hbar-fill";
        fill.style.width = `${Math.max(1, (count / max) * 100)}%`;
        track.appendChild(fill);

        const value = document.createElement("div");
        value.className = "hbar-value";
        value.textContent = Number(count).toLocaleString();

        row.append(labelEl, track, value);
        el.appendChild(row);
      }
    }

    function renderMonthlyTrend(labels, values) {
      const host = document.getElementById("trendChart");
      if (!host) return;
      host.replaceChildren();
      if (!values.length) {
        const empty = document.createElement("div");
        empty.className = "chart-empty";
        empty.textContent = "No monthly trend for the current selection.";
        host.appendChild(empty);
        return;
      }

      const NS = "http://www.w3.org/2000/svg";
      const width = 360, height = 160;
      const pad = { left: 32, right: 8, top: 12, bottom: 30 };
      const plotW = width - pad.left - pad.right;
      const plotH = height - pad.top - pad.bottom;
      const maxValue = Math.max(...values, 1);
      const xFor = i => values.length === 1 ? pad.left + plotW / 2 : pad.left + (i / (values.length - 1)) * plotW;
      const yFor = v => pad.top + plotH - (v / maxValue) * plotH;

      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.classList.add("trend-svg");

      for (let i = 0; i <= 4; i++) {
        const value = Math.round((maxValue * i) / 4);
        const y = yFor(value);
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", pad.left); line.setAttribute("x2", width - pad.right);
        line.setAttribute("y1", y); line.setAttribute("y2", y);
        line.setAttribute("class", "trend-grid");
        svg.appendChild(line);
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", pad.left - 4); t.setAttribute("y", y + 3);
        t.setAttribute("text-anchor", "end"); t.setAttribute("class", "trend-label");
        t.textContent = value.toLocaleString();
        svg.appendChild(t);
      }

      const axis = document.createElementNS(NS, "line");
      axis.setAttribute("x1", pad.left); axis.setAttribute("x2", width - pad.right);
      axis.setAttribute("y1", pad.top + plotH); axis.setAttribute("y2", pad.top + plotH);
      axis.setAttribute("class", "trend-axis");
      svg.appendChild(axis);

      const points = values.map((v, i) => `${xFor(i)},${yFor(v)}`).join(" ");
      const poly = document.createElementNS(NS, "polyline");
      poly.setAttribute("points", points); poly.setAttribute("class", "trend-line");
      svg.appendChild(poly);

      const labelEvery = Math.max(1, Math.ceil(labels.length / 5));
      values.forEach((v, i) => {
        const cx = xFor(i), cy = yFor(v);
        const circle = document.createElementNS(NS, "circle");
        circle.setAttribute("cx", cx); circle.setAttribute("cy", cy); circle.setAttribute("r", 2.5);
        circle.setAttribute("class", "trend-point");
        const title = document.createElementNS(NS, "title");
        title.textContent = `${labels[i]}: ${Number(v).toLocaleString()} fire incidents`;
        circle.appendChild(title);
        svg.appendChild(circle);

        if (i % labelEvery === 0 || i === labels.length - 1) {
          const text = document.createElementNS(NS, "text");
          text.setAttribute("x", cx); text.setAttribute("y", height - 10);
          text.setAttribute("text-anchor", "middle"); text.setAttribute("class", "trend-label");
          text.textContent = labels[i].replace(/\s\d{4}$/, "");
          svg.appendChild(text);
        }
      });

      host.appendChild(svg);
    }

    function updateKpis(features, geographyFeature) {
      const kpi = config.kpi || {};
      const fireField = kpi.fire_filter_field || "NERIS_CATEGORY";
      const fireValue = String(kpi.fire_filter_value || "FIRE").toUpperCase();
      const categoryField = kpi.category_field || "CRR_SUBCATEGORY";
      const dateField = kpi.date_field || "INC_DATE";
      const fireFeatures = features.filter(f => String(f.attributes?.[fireField] ?? "").toUpperCase() === fireValue);

      renderGeographySummary(geographyFeature, fireFeatures.length);

      const categoryCounts = new Map();
      for (const feature of fireFeatures) {
        const raw = feature.attributes?.[categoryField];
        const label = raw ? String(raw).replaceAll("_", " ") : "Unclassified";
        categoryCounts.set(label, (categoryCounts.get(label) || 0) + 1);
      }
      const categories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);

      renderCategoryBars(categories);

      const monthCounts = new Map();
      for (const feature of fireFeatures) {
        const d = new Date(feature.attributes?.[dateField]);
        if (Number.isNaN(d.getTime())) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
      }
      const months = [...monthCounts.keys()].sort();
      const monthLabels = months.map(key => {
        const [y, m] = key.split("-").map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString([], { month: "short", year: "numeric" });
      });

      renderMonthlyTrend(monthLabels, months.map(m => monthCounts.get(m)));
    }

    async function applyFilters() {
      const applyBtn = document.getElementById("applyBtn");
      statusEl.textContent = "Loading incidents...";

      if (applyBtn) applyBtn.disabled = true;

      try {
        const where = buildWhere();
        selectedGeographyFeature = await getSelectedGeography();
        const geographyGeometry = selectedGeographyFeature?.geometry || null;

        layer.definitionExpression = where;
        const layerView = await view.whenLayerView(layer);
        layerView.filter = geographyGeometry ? { geometry: geographyGeometry, spatialRelationship: "intersects" } : null;

        currentFeatures = await fetchAllFilteredFeatures(where, geographyGeometry);

        if (highlightHandle) {
          highlightHandle.remove();
          highlightHandle = null;
        }

        view.closePopup();
        renderList(currentFeatures);
        updateKpis(currentFeatures, selectedGeographyFeature);

        try {
          drawSelectedGeography(selectedGeographyFeature);
        } catch (styleErr) {
          console.warn("Unable to draw selected polygon style:", styleErr);
        }

        if (selectedGeographyFeature?.geometry) {
          try { await view.goTo(selectedGeographyFeature.geometry.extent.expand(1.08), { duration: 650 }); } catch (e) { if (e.name !== "AbortError") console.error(e); }
        } else if (currentFeatures.length) {
          await zoomToFilteredExtent(where);
        }

        statusEl.textContent =
          `${currentFeatures.length.toLocaleString()} incident` +
          `${currentFeatures.length === 1 ? "" : "s"} shown`;
      } catch (err) {
        console.error(err);
        statusEl.textContent = err?.message || "Unable to load incidents. See browser console for details.";
      } finally {
        if (applyBtn) applyBtn.disabled = false;
      }
    }

    async function clearFilters() {
      if (geographyControl) geographyControl.value = "";
      for (const filter of config.filters || []) {
        const control = filterControls.get(filter.id);
        if (!control) continue;

        if (filter.type === "date_range") {
          if (filter.default !== undefined) {
            control.value = String(filter.default);
          }
        }

        if (filter.type === "custom_date_range") {
          control.start.value = "";
          control.end.value = "";
        }

        if (filter.type === "unique_values") {
          Array.from(control.options).forEach(o => {
            o.selected = false;
          });
        }
      }

      syncDateFilterExclusivity();

      // Rebuild cascading value lists from the cleared parent selections.
      await loadUniqueFilterValues();
      await applyFilters();
    }

    view.when(async () => {
      try {
        statusEl.textContent = config.behavior?.default_status_text || "Loading...";

        await layer.load();
        loadPublicationStatus();

        createFilterUI();
        await loadGeographies();
        syncDateFilterExclusivity();

        statusEl.textContent = "Loading filter values...";
        await loadUniqueFilterValues();

        await applyFilters();
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Initialization failed. See browser console for details.";
      }
    });
  });
})().catch(err => {
  console.error(err);
  const status = document.getElementById("status");
  if (status) {
    status.textContent = "Unable to load configuration. See browser console for details.";
  }
});
