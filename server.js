require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const port = process.env.PORT || 3000;

// Configuração do Middleware
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" })); // Limite alto para imagens Base64

// Conexão com Banco de Dados
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// --- Rotas de Autenticação ---

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email, role, active FROM users WHERE email = ? AND password = ?",
      [email, password] // Nota: Em produção, use hash bcrypt para comparar senhas
    );

    if (rows.length > 0) {
      if (!rows[0].active) {
        return res.status(403).json({ error: "Usuário inativo." });
      }
      res.json(rows[0]);
    } else {
      res.status(401).json({ error: "Credenciais inválidas." });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Rotas de Usuários ---

app.get("/api/users", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email, role, active FROM users"
    );
    // Converter tinyint(1) do MySQL para boolean
    const users = rows.map((u) => ({ ...u, active: !!u.active }));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/users", async (req, res) => {
  const { id, name, email, password, role, active } = req.body;
  try {
    await pool.query(
      "INSERT INTO users (id, name, email, password, role, active) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=?, email=?, role=?, active=?",
      [id, name, email, password, role, active, name, email, role, active]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/users/:id/status", async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  try {
    await pool.query("UPDATE users SET active = ? WHERE id = ?", [active, id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Rotas de Templates ---

app.get("/api/templates", async (req, res) => {
  try {
    const [templates] = await pool.query("SELECT * FROM checklist_templates");

    // Buscar itens para cada template
    // Otimização: Poderia usar JSON_ARRAYAGG se MySQL 5.7+
    const result = [];
    for (const t of templates) {
      const [items] = await pool.query(
        "SELECT item_label FROM checklist_template_items WHERE template_id = ? ORDER BY display_order",
        [t.id]
      );
      result.push({
        id: t.id,
        name: t.name,
        items: items.map((i) => i.item_label),
      });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/templates", async (req, res) => {
  const { id, name, items } = req.body;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Upsert Template
    const [existing] = await connection.query(
      "SELECT id FROM checklist_templates WHERE id = ?",
      [id]
    );
    if (existing.length > 0) {
      await connection.query(
        "UPDATE checklist_templates SET name = ? WHERE id = ?",
        [name, id]
      );
      await connection.query(
        "DELETE FROM checklist_template_items WHERE template_id = ?",
        [id]
      );
    } else {
      await connection.query(
        "INSERT INTO checklist_templates (id, name) VALUES (?, ?)",
        [id, name]
      );
    }

    // Insert Items
    if (items.length > 0) {
      const values = items.map((item, index) => [id, item, index]);
      await connection.query(
        "INSERT INTO checklist_template_items (template_id, item_label, display_order) VALUES ?",
        [values]
      );
    }

    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

app.delete("/api/templates/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM checklist_templates WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Rotas de Tarefas ---

app.get("/api/tasks", async (req, res) => {
  try {
    const [tasks] = await pool.query(
      "SELECT * FROM tasks ORDER BY created_at DESC"
    );

    const result = [];
    for (const t of tasks) {
      const [items] = await pool.query(
        "SELECT id, label, is_checked FROM task_checklist_items WHERE task_id = ?",
        [t.id]
      );
      result.push({
        id: t.id,
        title: t.title,
        sector: t.sector,
        ticketId: t.ticket_id,
        description: t.description,
        responsible: t.responsible_name,
        createdAt: Number(t.created_at),
        checklist: items.map((i) => ({
          id: String(i.id),
          label: i.label,
          checked: !!i.is_checked,
        })),
      });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tasks", async (req, res) => {
  const {
    id,
    title,
    sector,
    ticketId,
    description,
    responsible,
    checklist,
    createdAt,
  } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Check existance
    const [existing] = await connection.query(
      "SELECT id FROM tasks WHERE id = ?",
      [id]
    );

    if (existing.length > 0) {
      await connection.query(
        "UPDATE tasks SET title=?, sector=?, ticket_id=?, description=?, responsible_name=? WHERE id=?",
        [title, sector, ticketId, description, responsible, id]
      );
      // Re-insert checklist items for simplicity in update logic
      await connection.query(
        "DELETE FROM task_checklist_items WHERE task_id = ?",
        [id]
      );
    } else {
      await connection.query(
        "INSERT INTO tasks (id, title, sector, ticket_id, description, responsible_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, title, sector, ticketId, description, responsible, createdAt]
      );
    }

    if (checklist && checklist.length > 0) {
      const values = checklist.map((item) => [id, item.label, item.checked]);
      await connection.query(
        "INSERT INTO task_checklist_items (task_id, label, is_checked) VALUES ?",
        [values]
      );
    }

    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM tasks WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Rotas de Logs/Histórico ---

app.get("/api/rounds", async (req, res) => {
  try {
    // Buscar Logs
    const [rows] = await pool.query(
      "SELECT * FROM round_logs ORDER BY start_time DESC"
    );

    // Mapear resultados
    const logs = await Promise.all(
      rows.map(async (row) => {
        // Buscar fotos
        const [photos] = await pool.query(
          "SELECT photo_base64 FROM round_evidence_photos WHERE round_id = ?",
          [row.id]
        );

        return {
          id: row.id,
          taskId: row.task_id,
          taskTitle: row.task_title,
          sector: row.sector,
          ticketId: row.ticket_id,
          responsible: row.responsible_name,
          startTime: Number(row.start_time),
          endTime: Number(row.end_time),
          durationSeconds: row.duration_seconds,
          observations: row.observations,
          issuesDetected: !!row.issues_detected,
          aiAnalysis: row.ai_analysis,
          signature: row.signature_base64,
          validationToken: row.validation_token,
          checklistState: row.checklist_snapshot, // O MySQL driver já faz o parse do JSON
          photos: photos.map((p) => p.photo_base64),
        };
      })
    );

    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/rounds", async (req, res) => {
  const log = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO round_logs 
      (id, task_id, task_title, sector, ticket_id, responsible_name, start_time, end_time, duration_seconds, observations, issues_detected, ai_analysis, signature_base64, validation_token, checklist_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.id,
        log.taskId,
        log.taskTitle,
        log.sector,
        log.ticketId,
        log.responsible,
        log.startTime,
        log.endTime,
        log.durationSeconds,
        log.observations,
        log.issuesDetected,
        log.aiAnalysis,
        log.signature,
        log.validationToken,
        JSON.stringify(log.checklistState),
      ]
    );

    if (log.photos && log.photos.length > 0) {
      const photoValues = log.photos.map((p) => [log.id, p]);
      await connection.query(
        "INSERT INTO round_evidence_photos (round_id, photo_base64) VALUES ?",
        [photoValues]
      );
    }

    await connection.commit();
    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    connection.release();
  }
});

// --- Configurações ---

app.get("/api/settings", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM system_settings WHERE id = 1"
    );
    if (rows.length > 0) {
      res.json({
        companyName: rows[0].company_name,
        headerColor: rows[0].header_color,
        logo: rows[0].logo_base64,
      });
    } else {
      res.json({
        companyName: "RondaGuard",
        headerColor: "#203060",
        logo: null,
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/settings", async (req, res) => {
  const { companyName, headerColor, logo } = req.body;
  try {
    await pool.query(
      "INSERT INTO system_settings (id, company_name, header_color, logo_base64) VALUES (1, ?, ?, ?) ON DUPLICATE KEY UPDATE company_name=?, header_color=?, logo_base64=?",
      [companyName, headerColor, logo, companyName, headerColor, logo]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  (async () => {
    try {
      const conn = await pool.getConnection();
      console.log(`API Server running on port ${port}`);
      console.log("✅ MySQL conectado com sucesso");
      conn.release();
    } catch (err) {
      console.error("❌ Erro ao conectar no MySQL:", err.message);
    }
  })();
});
