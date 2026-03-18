import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import db from "./src/database.ts";
import { sendExamResult } from "./src/email.ts";
import { v4 as uuidv4 } from 'uuid';

async function startServer() {
  const app = express();
  app.use(express.json());
  const PORT = 3000;

  // --- API Routes ---

  // Create Exam (Examiner)
  app.post("/api/exams", (req, res) => {
    const { title, examinerEmail, questions } = req.body;
    const examId = uuidv4();

    try {
      const insertExam = db.prepare("INSERT INTO exams (id, title, examiner_email) VALUES (?, ?, ?)");
      insertExam.run(examId, title, examinerEmail);

      const insertQuestion = db.prepare(
        "INSERT INTO questions (exam_id, question_text, options, correct_answer) VALUES (?, ?, ?, ?)"
      );

      const transaction = db.transaction((qs) => {
        for (const q of qs) {
          insertQuestion.run(examId, q.text, JSON.stringify(q.options), q.correctAnswer);
        }
      });

      transaction(questions);
      res.json({ examId });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get Exam Questions (Student - No Correct Answers)
  app.get("/api/exams/:id", (req, res) => {
    const examId = req.params.id;
    try {
      const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(examId) as any;
      if (!exam) return res.status(404).json({ error: "Exam not found" });

      const questions = db.prepare("SELECT id, question_text, options FROM questions WHERE exam_id = ?").all(examId) as any[];
      
      res.json({
        title: exam.title,
        questions: questions.map(q => ({
          id: q.id,
          text: q.question_text,
          options: JSON.parse(q.options)
        }))
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Submit Exam (Student)
  app.post("/api/exams/:id/submit", async (req, res) => {
    const examId = req.params.id;
    const { studentName, responses, status } = req.body;

    try {
      const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(examId) as any;
      if (!exam) return res.status(404).json({ error: "Exam not found" });

      const questions = db.prepare("SELECT id, correct_answer FROM questions WHERE exam_id = ?").all(examId) as any[];
      
      let score = 0;
      questions.forEach(q => {
        if (responses[q.id] === q.correct_answer) {
          score++;
        }
      });

      db.prepare(
        "INSERT INTO submissions (exam_id, student_name, responses, score, total_marks, status) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(examId, studentName, JSON.stringify(responses), score, questions.length, status);

      // Send email to examiner
      await sendExamResult({
        to: exam.examiner_email,
        studentName,
        score,
        totalMarks: questions.length,
        status,
        responses,
        examTitle: exam.title
      });

      res.json({ score, total: questions.length });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // --- Vite Integration ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
