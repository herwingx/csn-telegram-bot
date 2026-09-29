/**
 * ============================================================================
 * SISTEMA DE MONITOREO Y ALERTAS CSN (CENTRO DE SOLUCIONES NETO) VÍA TELEGRAM
 * ============================================================================
 * 
 * @description Daemon en Node.js que consulta de forma periódica el buzón institucional
 *              de NetoBox mediante el protocolo MCP (Model Context Protocol). Extrae
 *              folios de Zendesk, tiendas afectadas y prioridades para despachar
 *              notificaciones privadas a ingenieros de soporte técnico en campo.
 * 
 * @author Soporte Técnico Zona Chiapas
 * @version 2.5.0 (Producción / GitHub Ready / Multi-Tenant)
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

// ============================================================================
// GESTIÓN DE CONFIGURACIÓN Y PERSISTENCIA (CERO DEUDA TÉCNICA)
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
 * Guarda el estado actual en disco de manera segura.
 */
function guardarEstado() {
  try {
    fs.writeFileSync(PROCESADOS_FILE, JSON.stringify(estado), 'utf8');
  } catch (err) {
    console.error('[PERSISTENCIA] Error guardando estado:', err.message);
  }
}

/**
 * Obtiene o inicializa los registros locales de un ingeniero específico.
 * @param {string} chatId Identificador único de Telegram del ingeniero.
 */
function obtenerRegistroIngeniero(chatId) {
  if (!estado[chatId]) {
    estado[chatId] = { correos: [], folios: [], historial: [], pausado: false };
  }
  return {
    correos: new Set(estado[chatId].correos || []),
    folios: new Set(estado[chatId].folios || []),
    historial: estado[chatId].historial || [],
    pausado: Boolean(estado[chatId].pausado)
  };
}

/**
 * Actualiza los registros de un ingeniero manteniendo un tope de 300 elementos.
 */
function actualizarRegistroIngeniero(chatId, setCorreos, setFolios, historial, pausado) {
  estado[chatId] = {
    correos: Array.from(setCorreos).slice(-300),
    folios: Array.from(setFolios).slice(-300),
    historial: (historial || []).slice(-20),
    pausado: Boolean(pausado)
  };
  guardarEstado();
}

// ============================================================================
// UTILIDADES DE TEXTO, FECHA Y HORARIO
// ============================================================================

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
// COMUNICACIÓN EXTERNA: TELEGRAM BOT API Y NETOBOX MCP
// ============================================================================

/**
 * Envía un mensaje con formato HTML al chat privado de un ingeniero vía Telegram.
 */
async function enviarTelegram(chatId, mensaje) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mensaje,
        parse_mode: 'HTML',
        disable_notification: false
      })
    });
    const data = await res.json();
    if (!data.ok) console.error(`[TELEGRAM] Error enviando a ${chatId}:`, data.description);
  } catch (err) {
    console.error(`[TELEGRAM] Error de red hacia ${chatId}:`, err.message);
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
  const { correos, folios, historial, pausado } = obtenerRegistroIngeniero(ing.chatId);
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

        // 1. Extracción de datos
        const rawFolio = extraerRegex(email.subject + '\n' + cuerpo, /(?:Ticket\s*#?|solicitud\s*\(|#)(\d{4,8})/i, 1, '');
        const folio = rawFolio ? `#${rawFolio}` : 'Ver detalles';
        const tienda = extraerRegex(cuerpo, /(?:Solicitante|Organización|Tienda)\s*:?\s*([0-9]{3,4}\s*-[^\n\r<]+)/i, 1, 'No especificada');
        const prioridad = extraerRegex(cuerpo, /Prioridad\s*:?\s*([A-Za-zÁÉÍÓÚáéíóú]+)/i, 1, 'Normal');
        const hora = formatearHoraLocal(fechaCorreo);

        // 2. Clasificación de Estado
        const esResuelto = textoBusqueda.includes('marcado como resuelto') || 
                           textoBusqueda.includes('ha sido resuelto') ||
                           textoBusqueda.includes('ha sido cerrado') ||
                           textoBusqueda.includes('ticket resuelto') ||
                           textoBusqueda.includes('ticket cerrado') ||
                           /\bresuelto\b\s+ticket/i.test(cuerpo) ||
                           /\bcerrado\b\s+ticket/i.test(cuerpo);

        const esFolioConocido = rawFolio && folios.has(rawFolio);

        // Solo enviar mensaje si el ingeniero no tiene pausadas las notificaciones
        if (!pausado) {
          if (esResuelto) {
            const mensaje = 
`✅ <b>TICKET RESUELTO / CERRADO - SOLUCIONES NETO</b>

📋 <b>Folio:</b> <code>${folio}</code>
🏪 <b>Tienda:</b> <b>${tienda}</b>
📌 <b>Falla:</b> ${email.subject || 'Sin asunto'}
✔️ <b>Estado:</b> Marcado como resuelto en CSN
🕒 <b>Hora:</b> ${hora}`;

            await enviarTelegram(ing.chatId, mensaje);
            console.log(`[RESUELTO -> ${ing.nombre}] ${folio} | ${tienda} a las ${hora}`);
            notificadosEnCiclo++;

          } else if (esFolioConocido) {
            if (NOTIFICAR_ACTUALIZACIONES) {
              const nota = extraerNotaComentario(cuerpo);
              const seccionNota = nota ? `\n📝 <b>Nota:</b> <i>${nota}</i>` : '';

              const mensaje = 
`💬 <b>ACTUALIZACIÓN - SOLUCIONES NETO</b>

📋 <b>Folio:</b> <code>${folio}</code>
🏪 <b>Tienda:</b> <b>${tienda}</b>${seccionNota}
📌 <b>Falla:</b> ${email.subject || 'Sin asunto'}
🕒 <b>Hora:</b> ${hora}`;

              await enviarTelegram(ing.chatId, mensaje);
              console.log(`[ACTUALIZACIÓN -> ${ing.nombre}] ${folio} | ${tienda} a las ${hora}`);
              notificadosEnCiclo++;
            }
          } else {
            if (rawFolio) {
              folios.add(rawFolio);
              historial.push({ folio, tienda, falla: email.subject || 'Sin asunto', hora });
            }

            const mensaje = 
`🚨 <b>NUEVO TICKET ASIGNADO - SOLUCIONES NETO</b>

📋 <b>Folio:</b> <code>${folio}</code>
🏪 <b>Tienda:</b> <b>${tienda}</b>
⚡ <b>Prioridad:</b> ${prioridad}
📌 <b>Falla:</b> ${email.subject || 'Sin asunto'}
🕒 <b>Hora:</b> ${hora}`;

            await enviarTelegram(ing.chatId, mensaje);
            console.log(`[NUEVO TICKET -> ${ing.nombre}] ${folio} | ${tienda} a las ${hora}`);
            notificadosEnCiclo++;
          }
        } else {
          // Si está en silencio, solo registramos en historial sin enviar alerta audible
          if (!esFolioConocido && rawFolio) {
            folios.add(rawFolio);
            historial.push({ folio, tienda, falla: email.subject || 'Sin asunto', hora });
          }
        }
      }

      correos.add(email.id);
      actualizarRegistroIngeniero(ing.chatId, correos, folios, historial, pausado);
    }
  } catch (err) {
    console.error(`[ERROR] Consultando buzón de ${ing.nombre}:`, err.message);
    if (esManual) {
      await enviarTelegram(ing.chatId, `⚠️ Inconveniente al consultar tu buzón en NetoBox: <code>${err.message}</code>`);
    }
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
        const { pausado } = obtenerRegistroIngeniero(ing.chatId);
        if (!pausado) {
          await enviarTelegram(ing.chatId, '🌙 <b>Turno finalizado (11:00 PM)</b>\nMonitor en reposo nocturno. Próxima revisión automática a las 7:00 AM.');
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
        await enviarTelegram(ing.chatId, '☀️ <b>Turno iniciado (7:00 AM)</b>\nMonitor activo revisando tickets cada 20 min.');
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
// SUITE DE COMANDOS INTERACTIVOS (TELEGRAM LONG POLLING)
// ============================================================================

let ultimoUpdateId = 0;

async function escucharComandosTelegram() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${ultimoUpdateId + 1}&timeout=10`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.ok && data.result) {
      for (const update of data.result) {
        ultimoUpdateId = update.update_id;
        const msg = update.message;
        if (!msg || !msg.text) continue;

        const texto = msg.text.trim().toLowerCase();
        const chatId = String(msg.chat.id);
        const nombreUsuario = msg.chat.first_name || 'Compañero';
        const equipo = cargarEquipo();
        const registrado = equipo.find(e => String(e.chatId) === chatId);

        // --------------------------------------------------------------------
        // /start (Onboarding / Bienvenida)
        // --------------------------------------------------------------------
        if (texto.startsWith('/start')) {
          if (registrado) {
            await enviarTelegram(chatId, 
`👋 ¡Hola <b>${registrado.nombre}</b>!

El monitor de Soluciones Neto está activo para tu buzón.
Envía /ayuda para ver todos los comandos interactivos disponibles.`);
          } else {
            await enviarTelegram(chatId, 
`👋 ¡Hola <b>${nombreUsuario}</b>! Bienvenido al Monitor CSN.

Tu Telegram Chat ID es: <code>${chatId}</code>

📋 <b>Para activar tus notificaciones:</b>
Comparte este número a <b>Eduardo</b> junto con tu <b>PAT de NetoBox</b> para darte de alta.`);
          }
        }

        // --------------------------------------------------------------------
        // /status o /ping (Salud del servicio)
        // --------------------------------------------------------------------
        else if (texto === '/status' || texto === '/ping' || texto === 'status' || texto === 'ping') {
          if (registrado) {
            const { folios, pausado } = obtenerRegistroIngeniero(chatId);
            const respuesta = 
`🟢 <b>Monitor Operando Normal</b>

👤 <b>Ingeniero:</b> ${registrado.nombre}
🕒 <b>Última revisión:</b> ${ultimaRevisionHora}
⏱️ <b>Frecuencia:</b> Cada 20 min (:00, :20, :40)
📅 <b>Horario:</b> 7:00 AM a 11:00 PM
🔕 <b>Alertas en pausa:</b> ${pausado ? 'SÍ (Silenciado)' : 'NO (Activo)'}
📦 <b>Tickets en seguimiento:</b> ${folios.size}
💾 <b>Servidor:</b> GCP Compute Engine (us-central1)`;

            await enviarTelegram(chatId, respuesta);
          } else {
            await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Compártelo con Eduardo.`);
          }
        }

        // --------------------------------------------------------------------
        // /check o /revisar (Consulta manual inmediata)
        // --------------------------------------------------------------------
        else if (texto === '/check' || texto === '/revisar' || texto === 'check') {
          if (registrado) {
            await enviarTelegram(chatId, '🔍 <i>Consultando tu buzón de NetoBox en este momento...</i>');
            const nuevos = await procesarIngeniero(registrado, true);
            if (nuevos === 0) {
              await enviarTelegram(chatId, '✔️ <b>Buzón al día:</b> No tienes tickets nuevos ni actualizaciones pendientes en este momento.');
            }
          } else {
            await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Regístrate primero.`);
          }
        }

        // --------------------------------------------------------------------
        // /mis_folios o /historial (Últimos tickets asignados)
        // --------------------------------------------------------------------
        else if (texto === '/mis_folios' || texto === '/historial' || texto === 'folios') {
          if (registrado) {
            const { historial } = obtenerRegistroIngeniero(chatId);
            if (!historial || historial.length === 0) {
              await enviarTelegram(chatId, '📭 Aún no tienes folios registrados en el historial de hoy.');
            } else {
              const ultimos = historial.slice(-5).reverse();
              let respuesta = `📋 <b>Tus últimos folios asignados:</b>\n\n`;
              ultimos.forEach((item, idx) => {
                respuesta += `${idx + 1}. <code>${item.folio}</code> - <b>${item.tienda}</b>\n   📌 <i>${item.falla}</i> (${item.hora})\n\n`;
              });
              await enviarTelegram(chatId, respuesta.trim());
            }
          } else {
            await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Regístrate primero.`);
          }
        }

        // --------------------------------------------------------------------
        // /silencio o /pausa (Toggle de notificaciones)
        // --------------------------------------------------------------------
        else if (texto === '/silencio' || texto === '/pausa') {
          if (registrado) {
            const reg = obtenerRegistroIngeniero(chatId);
            reg.pausado = !reg.pausado;
            actualizarRegistroIngeniero(chatId, reg.correos, reg.folios, reg.historial, reg.pausado);

            if (reg.pausado) {
              await enviarTelegram(chatId, '🔕 <b>Alertas en pausa:</b> No recibirás notificaciones sonoras hasta que vuelvas a enviar /silencio.');
            } else {
              await enviarTelegram(chatId, '🔔 <b>Alertas reactivadas:</b> Volverás a recibir notificaciones normales de tus folios.');
            }
          } else {
            await enviarTelegram(chatId, `⚠️ Tu Chat ID es <code>${chatId}</code>. Regístrate primero.`);
          }
        }

        // --------------------------------------------------------------------
        // /servidor o /info (Telemetría de la VM en GCP)
        // --------------------------------------------------------------------
        else if (texto === '/servidor' || texto === '/info') {
          const totalRam = (os.totalmem() / 1024 / 1024).toFixed(0);
          const freeRam = (os.freemem() / 1024 / 1024).toFixed(0);
          const usedRam = (totalRam - freeRam).toFixed(0);
          const porcentaje = ((usedRam / totalRam) * 100).toFixed(1);
          const uptimeHrs = (os.uptime() / 3600).toFixed(1);
          const equipo = cargarEquipo();

          const infoServidor = 
`💻 <b>MÉTRICAS DEL SERVIDOR EN LA NUBE</b>

☁️ <b>Plataforma:</b> GCP Compute Engine (e2-micro)
📍 <b>Región:</b> us-central1 (Iowa)
⏱️ <b>Uptime VM:</b> ${uptimeHrs} horas activas
🧠 <b>Memoria RAM:</b> ${usedRam} MB / ${totalRam} MB (${porcentaje}%)
👥 <b>Ingenieros activos:</b> ${equipo.length}
🟢 <b>Estado del Daemon:</b> Online (PM2 + systemd)`;

          await enviarTelegram(chatId, infoServidor);
        }

        // --------------------------------------------------------------------
        // /ayuda o /help (Menú interactivo)
        // --------------------------------------------------------------------
        else if (texto === '/ayuda' || texto === '/help' || texto === 'ayuda') {
          const menu = 
`🤖 <b>SUITE DE COMANDOS - MONITOR CSN</b>

/check - Sondeo manual inmediato a tu buzón en este instante.
/mis_folios - Consulta los últimos 5 folios asignados a tu cuenta.
/status - Estado del servicio y última hora de revisión.
/silencio - Pausa o reactiva temporalmente tus notificaciones.
/servidor - Muestra métricas de CPU, RAM y Uptime del servidor en GCP.
/ayuda - Muestra este menú de opciones.

🕒 <b>Horario operativo:</b> 7:00 AM a 11:00 PM (cada 20 min).`;

          await enviarTelegram(chatId, menu);
        }
      }
    }
  } catch (_) {}

  setTimeout(escucharComandosTelegram, 4000);
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
  console.log('📡 Monitor Multi-Ingeniero Soluciones Neto iniciado...');
  iniciarPlanificador();
  escucharComandosTelegram();
})();
