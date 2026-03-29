const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;

// Railway inyecta DATABASE_URL automáticamente
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ─── INICIAR TABLA ───────────────────────────────────────────────
async function iniciarDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      numero INTEGER NOT NULL,
      cliente TEXT,
      items JSONB NOT NULL,
      total INTEGER NOT NULL,
      hora TEXT NOT NULL,
      fecha TEXT NOT NULL,
      entregado BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Tabla pedidos lista');
}

// ─── HELPERS ─────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function hoy() {
  const n = new Date();
  return `${String(n.getDate()).padStart(2,'0')}/${String(n.getMonth()+1).padStart(2,'0')}/${n.getFullYear()}`;
}

// ─── SERVIDOR ────────────────────────────────────────────────────
async function startServer() {
  await iniciarDB();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS') { jsonResponse(res, 204, {}); return; }

    // Servir index.html
    if (method === 'GET' && pathname === '/') {
      fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
        if (err) { res.writeHead(404); res.end('index.html no encontrado'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    // Servir admin.html
    if (method === 'GET' && pathname === '/admin') {
      fs.readFile(path.join(__dirname, 'admin.html'), (err, data) => {
        if (err) { res.writeHead(404); res.end('admin.html no encontrado'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    // GET /api/pedidos/rango?desde=DD/MM/YYYY&hasta=DD/MM/YYYY
    if (method === 'GET' && pathname === '/api/pedidos/rango') {
      const desde = url.searchParams.get('desde') || hoy();
      const hasta = url.searchParams.get('hasta') || hoy();
      const result = await pool.query(
        `SELECT * FROM pedidos 
         WHERE to_date(fecha,'DD/MM/YYYY') BETWEEN to_date($1,'DD/MM/YYYY') AND to_date($2,'DD/MM/YYYY')
         ORDER BY to_date(fecha,'DD/MM/YYYY') DESC, id DESC`,
        [desde, hasta]
      );
      jsonResponse(res, 200, result.rows);
      return;
    }

    // GET /api/stats — estadísticas generales
    if (method === 'GET' && pathname === '/api/stats') {
      const total     = await pool.query('SELECT COUNT(*) as n, COALESCE(SUM(total),0) as ventas FROM pedidos');
      const hoyData   = await pool.query('SELECT COUNT(*) as n, COALESCE(SUM(total),0) as ventas FROM pedidos WHERE fecha=$1', [hoy()]);
      const topItems  = await pool.query(`
        SELECT item->>'nombre' as nombre, SUM((item->>'qty')::int) as cantidad
        FROM pedidos, jsonb_array_elements(items) as item
        GROUP BY item->>'nombre'
        ORDER BY cantidad DESC LIMIT 5
      `);
      jsonResponse(res, 200, {
        total: total.rows[0],
        hoy: hoyData.rows[0],
        top_productos: topItems.rows
      });
      return;
    }

    // GET /api/pedidos?fecha=DD/MM/YYYY
    if (method === 'GET' && pathname === '/api/pedidos') {
      const fecha = url.searchParams.get('fecha') || hoy();
      const result = await pool.query(
        'SELECT * FROM pedidos WHERE fecha=$1 ORDER BY id DESC', [fecha]
      );
      jsonResponse(res, 200, result.rows);
      return;
    }

    // GET /api/resumen
    if (method === 'GET' && pathname === '/api/resumen') {
      const fecha = hoy();
      const t = await pool.query(
        'SELECT COUNT(*) as total_pedidos, COALESCE(SUM(total),0) as ventas FROM pedidos WHERE fecha=$1', [fecha]
      );
      const e = await pool.query(
        'SELECT COUNT(*) as n FROM pedidos WHERE fecha=$1 AND entregado=TRUE', [fecha]
      );
      jsonResponse(res, 200, { fecha, ...t.rows[0], entregados: parseInt(e.rows[0].n) });
      return;
    }

    // POST /api/pedidos
    if (method === 'POST' && pathname === '/api/pedidos') {
      const b = await readBody(req);
      if (!b.numero || !b.items || !b.total || !b.hora) {
        jsonResponse(res, 400, { error: 'Datos incompletos' }); return;
      }
      const result = await pool.query(
        'INSERT INTO pedidos (numero,cliente,items,total,hora,fecha) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [b.numero, b.cliente || null, JSON.stringify(b.items), b.total, b.hora, hoy()]
      );
      jsonResponse(res, 201, result.rows[0]);
      return;
    }

    // PUT /api/pedidos/:id
    if (method === 'PUT' && pathname.startsWith('/api/pedidos/')) {
      const id = parseInt(pathname.split('/').pop());
      const b = await readBody(req);
      const ex = await pool.query('SELECT * FROM pedidos WHERE id=$1', [id]);
      if (!ex.rows.length) { jsonResponse(res, 404, { error: 'No encontrado' }); return; }
      const actual = ex.rows[0];
      const items     = b.items     !== undefined ? JSON.stringify(b.items) : JSON.stringify(actual.items);
      const total     = b.total     !== undefined ? b.total     : actual.total;
      const entregado = b.entregado !== undefined ? b.entregado : actual.entregado;
      const cliente   = b.cliente   !== undefined ? b.cliente   : actual.cliente;
      const result = await pool.query(
        'UPDATE pedidos SET items=$1,total=$2,entregado=$3,cliente=$4 WHERE id=$5 RETURNING *',
        [items, total, entregado, cliente, id]
      );
      jsonResponse(res, 200, result.rows[0]);
      return;
    }

    // DELETE /api/pedidos/:id
    if (method === 'DELETE' && pathname.startsWith('/api/pedidos/')) {
      const id = parseInt(pathname.split('/').pop());
      await pool.query('DELETE FROM pedidos WHERE id=$1', [id]);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // GET /api/export?fecha=DD/MM/YYYY
    if (method === 'GET' && pathname === '/api/export') {
      const fecha = url.searchParams.get('fecha') || hoy();
      const result = await pool.query(
        'SELECT * FROM pedidos WHERE fecha=$1 ORDER BY id ASC', [fecha]
      );
      let csv = 'ID,Número,Cliente,Items,Total,Hora,Fecha,Entregado\n';
      result.rows.forEach(r => {
        const items = (Array.isArray(r.items) ? r.items : JSON.parse(r.items))
          .map(i => `${i.qty}x ${i.nombre}`).join(' | ');
        csv += `${r.id},${r.numero},"${r.cliente||''}","${items}",${r.total},${r.hora},${r.fecha},${r.entregado?'Sí':'No'}\n`;
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sabor58-${fecha.replace(/\//g,'-')}.csv"`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end('\uFEFF' + csv);
      return;
    }

    jsonResponse(res, 404, { error: 'Ruta no encontrada' });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🇻🇪  SABOR +58 corriendo en puerto ${PORT}`);
    console.log(`💾  PostgreSQL conectado\n`);
  });
}

startServer().catch(e => {
  console.error('Error fatal:', e);
  process.exit(1);
});
