/**
 * ============================================================================
 * SISTEMA DE MONITOREO Y ALERTAS CSN (CENTRO DE SOLUCIONES NETO) VÍA TELEGRAM
 * ============================================================================
 * 
 * @description Daemon en Node.js que consulta de forma periódica el buzón institucional
 *              de NetoBox mediante el protocolo MCP (Model Context Protocol). Extrae
 *              folios de Zendesk, tiendas afectadas y prioridades para despachar
 *              notificaciones privadas e interactivas a ingenieros de soporte en campo.
 * 
 * @author Soporte Técnico Zona Chiapas
 * @version 3.0.0 (Producción / UI Interactiva / Multi-Tenant)
 * @license MIT
 * ============================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// CONFIGURACIÓN GLOBAL (VARIABLES DE ENTORNO)
// ============================================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NETOBOX_MCP_URL = process.env.NETOBOX_MCP_URL || 'https://netobox.soyneto.com/api/mcp';
const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';
const NOTIFICAR_ACTUALIZACIONES = process.env.NOTIFICAR_ACTUALIZACIONES === 'true';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('[FATAL] No se encontró TELEGRAM_BOT_TOKEN en el archivo .env');
  process.exit(1);
}

// Rutas de almacenamiento local
const EQUIPO_FILE = path.join(__dirname, 'equipo.json');
const PROCESADOS_FILE = path.join(__dirname, 'procesados.json');

// Control de concurrencia para evitar doble escaneo simultáneo (cron vs /check manual)
const ingenierosEnProceso = new Set();

// ============================================================================
// GESTIÓN DE CONFIGURACIÓN Y PERSISTENCIA (ESCRITURA ATÓMICA)
// ============================================================================

/**
 * Carga la lista de ingenieros registrados desde equipo.json.
 * @returns {Array<{nombre: string, chatId: string, pat: string}>} Lista de ingenieros activos.
 */
function cargarEquipo() {
  if (!fs.existsSync(EQUIPO_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(EQUIPO_FILE, 'utf8'));
  } catch (err) {
    console.error(`[CONFIG] Error al leer ${EQUIPO_FILE}:`, err.message);
    return [];
  }
}

/**
 * Carga el estado histórico de correos procesados y folios registrados por ingeniero.
 */
let estado = {};
if (fs.existsSync(PROCESADOS_FILE)) {
  try {
    estado = JSON.parse(fs.readFileSync(PROCESADOS_FILE, 'utf8'));
  } catch (err) {
    console.error(`[PERSISTENCIA] Error al leer ${PROCESADOS_FILE}:`, err.message);
    estado = {};
  }
}

/**
 * Guarda el estado actual en disco de manera atómica (vía archivo temporal)
 * para evitar corrupción si el servidor se reinicia a mitad de escritura.
 */
function guardarEstado() {
  const tempFile = `${PROCESADOS_FILE}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(estado, null, 2), 'utf8');
    fs.renameSync(tempFile, PROCESADOS_FILE);
  } catch (err) {
    console.error('[PERSISTENCIA] Error guardando estado:', err.message);
  }
}

/**
 * Obtiene la fecha actual en formato YYYY-MM-DD según la zona horaria configurada.
 */
function obtenerFechaHoy() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/**
 * Obtiene o inicializa los registros locales de un ingeniero específico.
 * Mantiene total retrocompatibilidad con archivos procesados.json existentes.
 * @param {string} chatId Identificador único de Telegram del ingeniero.
 */
function obtenerRegistroIngeniero(chatId) {
  const hoy = obtenerFechaHoy();
  if (!estado[chatId]) {
    estado[chatId] = {
      correos: [],
      folios: [],
      historial: [],
      pausado: false,
      metricasDia: { fecha: hoy, nuevos: 0, resueltos: 0, actualizaciones: 0 }
    };
  }

  const metricasGuardadas = estado[chatId].metricasDia;
  const metricasDia = (metricasGuardadas && metricasGuardadas.fecha === hoy)
    ? {
        fecha: hoy,
        nuevos: Number(metricasGuardadas.nuevos || 0),
        resueltos: Number(metricasGuardadas.resueltos || 0),
        actualizaciones: Number(metricasGuardadas.actualizaciones || 0)
      }
    : { fecha: hoy, nuevos: 0, resueltos: 0, actualizaciones: 0 };

  return {
    correos: new Set(estado[chatId].correos || []),
    folios: new Set(estado[chatId].folios || []),
    historial: estado[chatId].historial || [],
    pausado: Boolean(estado[chatId].pausado),
    metricasDia
  };
}

/**
 * Actualiza los registros de un ingeniero manteniendo un tope de 300 elementos.
 */
function actualizarRegistroIngeniero(chatId, setCorreos, setFolios, historial, pausado, metricasDia) {
  estado[chatId] = {
    correos: Array.from(setCorreos).slice(-300),
    folios: Array.from(setFolios).slice(-300),
    historial: (historial || []).slice(-20),
    pausado: Boolean(pausado),
    metricasDia: metricasDia || obtenerRegistroIngeniero(chatId).metricasDia
  };
  guardarEstado();
}

// ============================================================================
// UTILIDADES DE TEXTO, FORMATO VISUAL, FECHA Y HORARIO
// ============================================================================

/**
 * Escapa caracteres especiales de HTML para evitar que Telegram rechace mensajes
 * cuando un correo contiene símbolos como <, > o & en el asunto o tienda.
 */
function escaparHtml(texto) {
  if (texto === null || texto === undefined) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Limpia prefijos repetitivos de los asuntos de correo para mostrar una falla limpia.
 */
function limpiarAsunto(asunto) {
  if (!asunto) return 'Sin asunto especificado';
  const limpio = String(asunto)
    .replace(/^(\s*(re|rv|fwd|fw)\s*:\s*)+/gi, '')
    .replace(/\[[^\]]*soluciones\s*neto[^\]]*\]\s*/gi, '')
    .replace(/^(actualizaci[oó]n\s+de\s+ticket|nuevo\s+ticket|asignaci[oó]n\s+de\s+ticket)\s*[:\-]?\s*/i, '')
    .trim();
  return limpio || String(asunto).trim();
}

/**
 * Devuelve una etiqueta visual con semáforo de color según el nivel de prioridad.
 */
function formatearPrioridad(prioridadRaw) {
  const p = String(prioridadRaw || 'Normal').trim();
  const lower = p.toLowerCase();
  if (lower.includes('urgent') || lower.includes('crític') || lower.includes('critic')) {
    return `🔴 <b>${escaparHtml(p.toUpperCase())}</b>`;
  }
  if (lower.includes('alta') || lower.includes('high')) {
    return `🟠 <b>${escaparHtml(p)}</b>`;
  }
  if (lower.includes('baja') || lower.includes('low')) {
    return `🟢 <b>${escaparHtml(p)}</b>`;
  }
  return `🟡 <b>${escaparHtml(p)}</b>`;
}

/**
 * Genera una barra de progreso visual en texto (ej. [████░░░░░░] 40%).
 */
function generarBarraProgreso(porcentaje, bloques = 10) {
  const pct = Math.max(0, Math.min(100, Number(porcentaje) || 0));
  const llenos = Math.round((pct / 100) * bloques);
  const vacios = Math.max(0, bloques - llenos);
  return `${'█'.repeat(llenos)}${'░'.repeat(vacios)}`;
}

/**
 * Extrae texto de forma segura utilizando expresiones regulares evitando fallos de tipo.
 */
function extraerRegex(texto, regex, grupo = 1, defecto = '') {
  if (!texto) return defecto;
  const match = String(texto).match(regex);
  if (!match) return defecto;
  const valor = match[grupo] !== undefined ? match[grupo] : match[0];
  return typeof valor === 'string' ? valor.trim() : defecto;
}

/**
 * Determina si la hora actual se encuentra en el rango laboral de soporte (7:00 AM a 11:00 PM).
 */
function estaEnHorarioLaboral() {
  const ahora = new Date();
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour12: false,
    hour: 'numeric',
    minute: 'numeric'
  }).formatToParts(ahora);

  const hora = parseInt(partes.find(p => p.type === 'hour').value, 10);
  const minuto = parseInt(partes.find(p => p.type === 'minute').value, 10);

  if (hora >= 7 && hora < 23) return true;
  if (hora === 23 && minuto === 0) return true;

  return false;
}

/**
 * Formatea cualquier valor de fecha a un formato limpio de 12 horas.
 */
function formatearHoraLocal(rawDate) {
  if (!rawDate) {
    return new Date().toLocaleTimeString('es-MX', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  }
  if (!isNaN(rawDate)) {
    const num = Number(rawDate);
    const d = num < 1e12 ? new Date(num * 1000) : new Date(num);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('es-MX', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
    }
  }
  const d = new Date(rawDate);
  if (!isNaN(d.getTime())) {
    return d.toLocaleTimeString('es-MX', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  }
  return extraerRegex(rawDate, /(\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?)/i, 1, 'Reciente');
}

function extraerNotaComentario(cuerpo) {
  return extraerRegex(cuerpo, /(?:Nota interna|comentario:?)\s*\n+([^\n\r]+)/i, 1, '');
}

// ============================================================================
// TECLADOS INTERACTIVOS (INLINE KEYBOARDS DE TELEGRAM)
// ============================================================================

/**
 * Botones rápidos para adjuntar debajo de cada alerta de ticket.
 */
function tecladoAlertaTicket() {
  return {
    inline_keyboard: [
      [
        { text: '🔍 Revisar Buzón', callback_data: 'cmd_check' },
        { text: '📋 Mis Folios', callback_data: 'cmd_folios' }
      ]
    ]
  };
}

/**
 * Panel principal de botones interactivos para el ingeniero.
 * @param {boolean} pausado Estado actual de pausa del ingeniero.
 */
function tecladoPanelPrincipal(pausado = false) {
  return {
    inline_keyboard: [
      [
        { text: '🔍 Revisar Ahora', callback_data: 'cmd_check' },
        { text: '📋 Mis Folios', callback_data: 'cmd_folios' }
      ],
      [
        { text: '📊 Mi Estado', callback_data: 'cmd_status' },
        { text: pausado ? '🔔 Activar Alertas' : '🔕 Silenciar Alertas', callback_data: 'cmd_silencio' }
      ],
      [
        { text: '💻 Estado del Servidor', callback_data: 'cmd_servidor' }
      ]
    ]
  };
}

// ============================================================================
// COMUNICACIÓN EXTERNA: TELEGRAM BOT API Y NETOBOX MCP
// ============================================================================

/**
 * Envía un mensaje con formato HTML al chat privado de un ingeniero vía Telegram.
 * Soporta botones inline opcionales y retorna el objeto del mensaje enviado.
 */
async function enviarTelegram(chatId, mensaje, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: mensaje,
    parse_mode: 'HTML',
    disable_notification: false
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`[TELEGRAM] Error enviando a ${chatId}:`, data.description);
      return null;
    }
    return data.result;
  } catch (err) {
    console.error(`[TELEGRAM] Error de red hacia ${chatId}:`, err.message);
    return null;
  }
}

/**
 * Edita un mensaje previamente enviado por el bot para evitar saturar el chat.
 */
async function editarTelegram(chatId, messageId, nuevoTexto, replyMarkup = null) {
  if (!messageId) return enviarTelegram(chatId, nuevoTexto, replyMarkup);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: nuevoTexto,
    parse_mode: 'HTML'
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok && !String(data.description || '').includes('message is not modified')) {
      return enviarTelegram(chatId, nuevoTexto, replyMarkup);
    }
    return data.result;
  } catch (_) {
    return enviarTelegram(chatId, nuevoTexto, replyMarkup);
  }
}

/**
 * Responde a un evento de botón inline (callback_query) para quitar el icono de carga.
 */
async function responderCallbackTelegram(callbackQueryId, textoToast = '') {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: textoToast || undefined
      })
    });
  } catch (_) {}
}

/**
 * Registra el menú oficial de comandos en Telegram para que aparezca el botón "Menú" en la app.
 */
async function configurarMenuComandos() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const commands = [
    { command: 'check', description: '🔍 Revisar mi buzón de NetoBox ahora mismo' },
    { command: 'mis_folios', description: '📋 Ver mis últimos 5 folios asignados' },
    { command: 'status', description: '📊 Estado operativo y resumen del día' },
    { command: 'silencio', description: '🔕 Pausar o reactivar notificaciones' },
    { command: 'servidor', description: '💻 Ver métricas de RAM y Uptime en GCP' },
    { command: 'ayuda', description: '📖 Mostrar panel interactivo de ayuda' }
  ];

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands })
    });
  } catch (err) {
    console.error('[TELEGRAM] No se pudo registrar el menú de comandos:', err.message);
  }
}

/**
 * Ejecuta una llamada RPC contra el servidor MCP de NetoBox compatible con SSE.
 */
async function llamarMCP(pat, toolName, args) {
  const res = await fetch(NETOBOX_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${pat}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    })
  });

  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${await res.text()}`);

  const rawText = await res.text();
  let data = null;

  if (rawText.includes('data:')) {
    for (const line of rawText.split('\n')) {
      if (line.startsWith('data:')) {
        const candidate = line.replace(/^data:\s*/, '').trim();
        if (candidate) {
          try { data = JSON.parse(candidate); break; } catch (_) {}
        }
      }
    }
  } else {
    data = JSON.parse(rawText);
  }

  if (data?.result?.content?.[0]?.text) {
    return JSON.parse(data.result.content[0].text);
  }
  return data?.result || data;
}

// ============================================================================
// NÚCLEO DE MONITOREO Y PROCESAMIENTO DE TICKETS
// ============================================================================

let ultimaRevisionHora = 'Iniciando...';
let avisadoInicioTurno = false;
let avisadoFinTurno = false;

/**
 * Procesa el buzón de un ingeniero en orden cronológico estricto.
 */
async function procesarIngeniero(ing, esManual = false) {
  const chatId = String(ing.chatId);

  if (ingenierosEnProceso.has(chatId)) {
    return 0;
  }
  ingenierosEnProceso.add(chatId);

  const { correos, folios, historial, pausado, metricasDia } = obtenerRegistroIngeniero(chatId);
  let notificadosEnCiclo = 0;

  try {
    const dataList = await llamarMCP(ing.pat, 'mail_list', { folder: 'all', limit: 15 });
    const emails = dataList.emails || [];

    // Invertir lista para orden cronológico (antiguo a reciente)
    const emailsCronologicos = [...emails].reverse();

    for (const email of emailsCronologicos) {
      if (correos.has(email.id)) continue;

      const remitente = (email.from || '') + ' ' + (email.fromEmail || '');
      const esNeto = remitente.toLowerCase().includes('soluciones neto') || 
                     remitente.toLowerCase().includes('centrodesolucionesneto') ||
                     remitente.toLowerCase().includes('soyneto');

      if (esNeto) {
        let cuerpo = '';
        let fechaCorreo = email.date;

        try {
          const detalle = await llamarMCP(ing.pat, 'mail_read', { emailId: email.id });
          cuerpo = detalle.body || detalle.snippet || '';
          if (detalle.date) fechaCorreo = detalle.date;
        } catch (e) {
          cuerpo = email.snippet || '';
        }

        const textoBusqueda = `${email.subject || ''}\n${cuerpo}`.toLowerCase();

        // 1. Extracción y saneamiento de datos
        const rawFolio = extraerRegex(email.subject + '\n' + cuerpo, /(?:Ticket\s*#?|solicitud\s*\(|#)(\d{4,8})/i, 1, '');
        const folio = rawFolio ? `#${rawFolio}` : 'Ver detalles';
        const tiendaRaw = extraerRegex(cuerpo, /(?:Solicitante|Organización|Tienda)\s*:?\s*([0-9]{3,4}\s*-[^\n\r<]+)/i, 1, 'No especificada');
        const prioridadRaw = extraerRegex(cuerpo, /Prioridad\s*:?\s*([A-Za-zÁÉÍÓÚáéíóú]+)/i, 1, 'Normal');
        const hora = formatearHoraLocal(fechaCorreo);
        const fallaLimpia = limpiarAsunto(email.subject);

        const folioHtml = escaparHtml(folio);
        const tiendaHtml = escaparHtml(tiendaRaw);
        const fallaHtml = escaparHtml(fallaLimpia);
        const prioridadBadge = formatearPrioridad(prioridadRaw);

        // 2. Clasificación de Estado
        const esResuelto = textoBusqueda.includes('marcado como resuelto') || 
                           textoBusqueda.includes('ha sido resuelto') ||
                           textoBusqueda.includes('ha sido cerrado') ||
                           textoBusqueda.includes('ticket resuelto') ||
                           textoBusqueda.includes('ticket cerrado') ||
                           /\bresuelto\b\s+ticket/i.test(cuerpo) ||
                           /\bcerrado\b\s+ticket/i.test(cuerpo);

        const esFolioConocido = rawFolio && folios.has(rawFolio);

        // Contabilizar estadísticas del día y registrar historial
        if (esResuelto) {
          metricasDia.resueltos++;
        } else if (esFolioConocido) {
          metricasDia.actualizaciones++;
        } else {
          metricasDia.nuevos++;
          if (rawFolio) {
            folios.add(rawFolio);
            historial.push({ folio, tienda: tiendaRaw, falla: fallaLimpia, prioridad: prioridadRaw, hora });
          }
        }

        // 3. Despacho de notificación si no está en modo silencio
        if (!pausado) {
          if (esResuelto) {
            const mensaje = 
`✅ <b>TICKET RESUELTO / CERRADO</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
🏷 <b>Folio:</b> <code>${folioHtml}</code>
🏪 <b>Tienda:</b> <b>${tiendaHtml}</b>
✔️ <b>Estado:</b> Cerrado en CSN
🕒 <b>Hora:</b> ${escaparHtml(hora)}

<blockquote>📌 <b>Falla:</b> ${fallaHtml}</blockquote>`;

            await enviarTelegram(chatId, mensaje, tecladoAlertaTicket());
            console.log(`[RESUELTO -> ${ing.nombre}] ${folio} | ${tiendaRaw} a las ${hora}`);
            notificadosEnCiclo++;

          } else if (esFolioConocido) {
            if (NOTIFICAR_ACTUALIZACIONES) {
              const nota = extraerNotaComentario(cuerpo);
              const bloqueNota = nota ? `\n📝 <b>Nota:</b> <i>${escaparHtml(nota)}</i>` : '';

              const mensaje = 
`💬 <b>ACTUALIZACIÓN DE TICKET</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
🏷 <b>Folio:</b> <code>${folioHtml}</code>
🏪 <b>Tienda:</b> <b>${tiendaHtml}</b>
🕒 <b>Hora:</b> ${escaparHtml(hora)}

<blockquote>📌 <b>Asunto:</b> ${fallaHtml}${bloqueNota}</blockquote>`;

              await enviarTelegram(chatId, mensaje, tecladoAlertaTicket());
              console.log(`[ACTUALIZACIÓN -> ${ing.nombre}] ${folio} | ${tiendaRaw} a las ${hora}`);
              notificadosEnCiclo++;
            }
          } else {
            const mensaje = 
`🚨 <b>NUEVO TICKET ASIGNADO</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
🏷 <b>Folio:</b> <code>${folioHtml}</code>  ·  ${prioridadBadge}
🏪 <b>Tienda:</b> <b>${tiendaHtml}</b>
🕒 <b>Hora:</b> ${escaparHtml(hora)}

<blockquote>📌 <b>Reporte:</b>
${fallaHtml}</blockquote>`;

            await enviarTelegram(chatId, mensaje, tecladoAlertaTicket());
            console.log(`[NUEVO TICKET -> ${ing.nombre}] ${folio} | ${tiendaRaw} a las ${hora}`);
            notificadosEnCiclo++;
          }
        }
      }

      correos.add(email.id);
      actualizarRegistroIngeniero(chatId, correos, folios, historial, pausado, metricasDia);
    }
  } catch (err) {
    console.error(`[ERROR] Consultando buzón de ${ing.nombre}:`, err.message);
    if (esManual) {
      await enviarTelegram(chatId, `⚠️ <b>Inconveniente al consultar tu buzón en NetoBox</b>\n<code>${escaparHtml(err.message)}</code>`);
    }
  } finally {
    ingenierosEnProceso.delete(chatId);
  }

  return notificadosEnCiclo;
}

/**
 * Sondeo automático programado.
 */
async function cicloMonitoreo() {
  const horaActual = new Date().toLocaleTimeString('es-MX', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
  ultimaRevisionHora = horaActual;
  const equipo = cargarEquipo();

  if (!estaEnHorarioLaboral()) {
    console.log(`[${horaActual}] Fuera de horario laboral (7am a 11pm). En reposo...`);
    if (!avisadoFinTurno) {
      for (const ing of equipo) {
        const { pausado, metricasDia } = obtenerRegistroIngeniero(ing.chatId);
        if (!pausado) {
          const msgFin = 
`🌙 <b>TURNO FINALIZADO (11:00 PM)</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
📊 <b>Resumen de tu jornada de hoy:</b>
  • 🚨 Tickets nuevos: <b>${metricasDia.nuevos}</b>
  • ✅ Resueltos / cerrados: <b>${metricasDia.resueltos}</b>
  • 💬 Actualizaciones: <b>${metricasDia.actualizaciones}</b>

<blockquote>💤 Monitor en reposo nocturno. Próxima revisión automática a las <b>7:00 AM</b>.</blockquote>`;
          await enviarTelegram(ing.chatId, msgFin);
        }
      }
      avisadoFinTurno = true;
      avisadoInicioTurno = false;
    }
    return;
  }

  if (!avisadoInicioTurno) {
    for (const ing of equipo) {
      const { pausado } = obtenerRegistroIngeniero(ing.chatId);
      if (!pausado) {
        const msgInicio = 
`☀️ <b>TURNO INICIADO (7:00 AM)</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
🟢 Monitor CSN activo para <b>${escaparHtml(ing.nombre)}</b>.
⏱️ Revisando tu buzón automáticamente cada <b>20 minutos</b>.`;
        await enviarTelegram(ing.chatId, msgInicio, tecladoAlertaTicket());
      }
    }
    avisadoInicioTurno = true;
    avisadoFinTurno = false;
  }

  console.log(`[${horaActual}] 🔍 Revisión periódica para ${equipo.length} ingeniero(s)...`);

  for (const ing of equipo) {
    await procesarIngeniero(ing);
  }
}

// ============================================================================
// SUITE DE COMANDOS Y BOTONES INTERACTIVOS (TELEGRAM LONG POLLING)
// ============================================================================

let ultimoUpdateId = 0;

/**
 * Ejecuta una acción o comando solicitado por un ingeniero (vía texto o botón inline).
 */
async function manejarAccionUsuario({ comando, chatId, nombreUsuario, registrado, equipo }) {
  // --------------------------------------------------------------------
  // /start (Onboarding / Bienvenida)
  // --------------------------------------------------------------------
  if (comando.startsWith('/start')) {
    if (registrado) {
      const { pausado } = obtenerRegistroIngeniero(chatId);
      const bienvenida = 
`👋 ¡Hola, <b>${escaparHtml(registrado.nombre)}</b>!
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
🟢 Tu monitor de <b>Soluciones Neto (CSN)</b> está activo y sincronizado con tu buzón.

Selecciona una acción rápida en los botones de abajo o usa el menú de comandos:`;
      await enviarTelegram(chatId, bienvenida, tecladoPanelPrincipal(pausado));
    } else {
      await enviarTelegram(chatId, 
`👋 ¡Hola, <b>${escaparHtml(nombreUsuario)}</b>! Bienvenido al Monitor CSN.
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
🔑 Tu Telegram Chat ID es: <code>${chatId}</code>

<blockquote>📋 <b>Para activar tus notificaciones:</b>
Comparte este número a <b>Eduardo</b> junto con tu <b>PAT de NetoBox</b> para darte de alta.</blockquote>`);
    }
  }

  // --------------------------------------------------------------------
  // /status o /ping (Salud del servicio y métricas del ingeniero)
  // --------------------------------------------------------------------
  else if (comando === '/status' || comando === '/ping' || comando === 'status' || comando === 'ping') {
    if (registrado) {
      const { folios, pausado, metricasDia } = obtenerRegistroIngeniero(chatId);
      const respuesta = 
`📊 <b>ESTADO DE TU MONITOR CSN</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
👤 <b>Ingeniero:</b> ${escaparHtml(registrado.nombre)}
🟢 <b>Servicio:</b> Operando normal
🔔 <b>Notificaciones:</b> ${pausado ? '🔕 En pausa (Silenciado)' : '🔔 Activas'}
🕒 <b>Última revisión:</b> ${escaparHtml(ultimaRevisionHora)}
⏱️ <b>Frecuencia:</b> Cada 20 min (:00, :20, :40)
📅 <b>Horario:</b> 7:00 AM a 11:00 PM

<blockquote>📈 <b>Actividad de hoy:</b>
🚨 Nuevos: <b>${metricasDia.nuevos}</b>  ·  ✅ Resueltos: <b>${metricasDia.resueltos}</b>  ·  📦 En seguimiento: <b>${folios.size}</b></blockquote>`;

      await enviarTelegram(chatId, respuesta, tecladoPanelPrincipal(pausado));
    } else {
      await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Compártelo con Eduardo para darte de alta.`);
    }
  }

  // --------------------------------------------------------------------
  // /check o /revisar (Consulta manual inmediata con edición en vivo)
  // --------------------------------------------------------------------
  else if (comando === '/check' || comando === '/revisar' || comando === 'check') {
    if (registrado) {
      const msgEspera = await enviarTelegram(chatId, '🔍 <i>Consultando tu buzón de NetoBox en este momento...</i>');
      const nuevos = await procesarIngeniero(registrado, true);
      const horaCheck = formatearHoraLocal();
      const { pausado } = obtenerRegistroIngeniero(chatId);

      if (nuevos === 0) {
        const msgAlDia = 
`✔️ <b>Buzón al día</b> <i>(${escaparHtml(horaCheck)})</i>
No tienes tickets nuevos ni actualizaciones pendientes en este momento.`;
        await editarTelegram(chatId, msgEspera?.message_id, msgAlDia, tecladoPanelPrincipal(pausado));
      } else {
        const msgNuevos = 
`✅ <b>Revisión completada</b> <i>(${escaparHtml(horaCheck)})</i>
Se procesaron y enviaron <b>${nuevos}</b> notificación(es) nueva(s).`;
        await editarTelegram(chatId, msgEspera?.message_id, msgNuevos, tecladoAlertaTicket());
      }
    } else {
      await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Regístrate primero.`);
    }
  }

  // --------------------------------------------------------------------
  // /mis_folios o /historial (Últimos tickets asignados)
  // --------------------------------------------------------------------
  else if (comando === '/mis_folios' || comando === '/historial' || comando === 'folios') {
    if (registrado) {
      const { historial, pausado } = obtenerRegistroIngeniero(chatId);
      if (!historial || historial.length === 0) {
        await enviarTelegram(
          chatId,
          '📭 <b>Sin folios recientes</b>\nAún no tienes folios registrados en tu historial reciente.',
          tecladoPanelPrincipal(pausado)
        );
      } else {
        const ultimos = historial.slice(-5).reverse();
        let respuesta = `📋 <b>TUS ÚLTIMOS FOLIOS ASIGNADOS</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━</code>\n\n`;
        ultimos.forEach((item, idx) => {
          const folioH = escaparHtml(item.folio);
          const tiendaH = escaparHtml(item.tienda);
          const fallaH = escaparHtml(limpiarAsunto(item.falla));
          const horaH = escaparHtml(item.hora);
          respuesta += `<b>${idx + 1}.</b> <code>${folioH}</code> · <b>${tiendaH}</b> <i>(${horaH})</i>\n<blockquote>📌 ${fallaH}</blockquote>\n`;
        });
        await enviarTelegram(chatId, respuesta.trim(), tecladoPanelPrincipal(pausado));
      }
    } else {
      await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Regístrate primero.`);
    }
  }

  // --------------------------------------------------------------------
  // /silencio o /pausa (Toggle de notificaciones)
  // --------------------------------------------------------------------
  else if (comando === '/silencio' || comando === '/pausa') {
    if (registrado) {
      const reg = obtenerRegistroIngeniero(chatId);
      reg.pausado = !reg.pausado;
      actualizarRegistroIngeniero(chatId, reg.correos, reg.folios, reg.historial, reg.pausado, reg.metricasDia);

      if (reg.pausado) {
        await enviarTelegram(
          chatId,
          `🔕 <b>ALERTAS EN PAUSA</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━</code>\nNo recibirás notificaciones de tickets hasta que las reactives con el botón de abajo o enviando /silencio.`,
          tecladoPanelPrincipal(true)
        );
      } else {
        await enviarTelegram(
          chatId,
          `🔔 <b>ALERTAS REACTIVADAS</b>\n<code>━━━━━━━━━━━━━━━━━━━━━━</code>\nVolverás a recibir notificaciones en tiempo real de tus folios asignados.`,
          tecladoPanelPrincipal(false)
        );
      }
    } else {
      await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Regístrate primero.`);
    }
  }

  // --------------------------------------------------------------------
  // /servidor o /info (Telemetría de la VM en GCP - Protegido para equipo)
  // --------------------------------------------------------------------
  else if (comando === '/servidor' || comando === '/info') {
    if (!registrado) {
      await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Acceso exclusivo para ingenieros registrados.`);
      return;
    }

    const totalRam = (os.totalmem() / 1024 / 1024).toFixed(0);
    const freeRam = (os.freemem() / 1024 / 1024).toFixed(0);
    const usedRam = (totalRam - freeRam).toFixed(0);
    const porcentaje = ((usedRam / totalRam) * 100).toFixed(1);
    const barraRam = generarBarraProgreso(porcentaje, 10);
    const uptimeHrs = (os.uptime() / 3600).toFixed(1);
    const { pausado } = obtenerRegistroIngeniero(chatId);

    const infoServidor = 
`💻 <b>TELEMETRÍA DEL SERVIDOR</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
☁️ <b>Plataforma:</b> GCP Compute Engine (e2-micro)
📍 <b>Región:</b> us-central1 (Iowa)
⏱️ <b>Uptime VM:</b> ${uptimeHrs} horas activas
👥 <b>Ingenieros activos:</b> ${equipo.length}
🟢 <b>Estado del Daemon:</b> Online (PM2 + systemd)

<blockquote>🧠 <b>Memoria RAM:</b> <code>[${barraRam}]</code> <b>${porcentaje}%</b>
Uso actual: ${usedRam} MB / ${totalRam} MB</blockquote>`;

    await enviarTelegram(chatId, infoServidor, tecladoPanelPrincipal(pausado));
  }

  // --------------------------------------------------------------------
  // /ayuda o /help (Menú interactivo)
  // --------------------------------------------------------------------
  else if (comando === '/ayuda' || comando === '/help' || comando === 'ayuda') {
    const { pausado } = registrado ? obtenerRegistroIngeniero(chatId) : { pausado: false };
    const menu = 
`🤖 <b>PANEL DE CONTROL - MONITOR CSN</b>
<code>━━━━━━━━━━━━━━━━━━━━━━</code>
🔍 <b>/check</b> — Sondeo manual inmediato a tu buzón.
📋 <b>/mis_folios</b> — Últimos 5 folios asignados a tu cuenta.
📊 <b>/status</b> — Estado del servicio y resumen de hoy.
🔕 <b>/silencio</b> — Pausa o reactiva tus notificaciones.
💻 <b>/servidor</b> — Métricas de RAM y Uptime en GCP.
📖 <b>/ayuda</b> — Muestra este panel interactivo.

<blockquote>🕒 <b>Horario operativo:</b> 7:00 AM a 11:00 PM (revisión automática cada 20 min).</blockquote>`;

    await enviarTelegram(chatId, menu, registrado ? tecladoPanelPrincipal(pausado) : null);
  }
}

async function escucharComandosTelegram() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${ultimoUpdateId + 1}&timeout=10`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.result) {
      for (const update of data.result) {
        ultimoUpdateId = update.update_id;
        const equipo = cargarEquipo();

        // 1. Manejo de Botones Interactivos (Inline Keyboard Callbacks)
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = String(cb.message?.chat?.id || cb.from?.id || '');
          const nombreUsuario = cb.from?.first_name || 'Compañero';
          const registrado = equipo.find(e => String(e.chatId) === chatId);
          const mapaAcciones = {
            cmd_check: '/check',
            cmd_folios: '/mis_folios',
            cmd_status: '/status',
            cmd_silencio: '/silencio',
            cmd_servidor: '/servidor',
            cmd_ayuda: '/ayuda'
          };
          const comandoEquivalente = mapaAcciones[cb.data];

          await responderCallbackTelegram(cb.id);
          if (comandoEquivalente && chatId) {
            await manejarAccionUsuario({
              comando: comandoEquivalente,
              chatId,
              nombreUsuario,
              registrado,
              equipo
            });
          }
          continue;
        }

        // 2. Manejo de Comandos de Texto Tradicionales
        const msg = update.message;
        if (!msg || !msg.text) continue;

        // Ignorar sufijos @NombreDelBot en comandos enviados desde grupos o menús
        const texto = msg.text.trim().toLowerCase().replace(/@\S+/, '');
        const chatId = String(msg.chat.id);
        const nombreUsuario = msg.chat.first_name || 'Compañero';
        const registrado = equipo.find(e => String(e.chatId) === chatId);

        await manejarAccionUsuario({
          comando: texto,
          chatId,
          nombreUsuario,
          registrado,
          equipo
        });
      }
    }
  } catch (_) {}

  setTimeout(escucharComandosTelegram, 3000);
}

// ============================================================================
// PLANIFICADOR TEMPORAL (:00, :20, :40)
// ============================================================================

function iniciarPlanificador() {
  cicloMonitoreo();

  let ultimoMinutoEjecutado = -1;

  setInterval(() => {
    const ahora = new Date();
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      minute: 'numeric'
    }).formatToParts(ahora);

    const minuto = parseInt(partes.find(p => p.type === 'minute').value, 10);

    if (minuto % 20 === 0 && minuto !== ultimoMinutoEjecutado) {
      ultimoMinutoEjecutado = minuto;
      cicloMonitoreo();
    }
  }, 15000);
}

(async () => {
  console.log('📡 Monitor Multi-Ingeniero Soluciones Neto (v3.0) iniciado...');
  await configurarMenuComandos();
  iniciarPlanificador();
  escucharComandosTelegram();
})();
