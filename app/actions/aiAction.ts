"use server"
import { GoogleGenAI } from "@google/genai"

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_GENAI_API_KEY,
})
export async function generateTextAction(prompt:string): Promise<string>{
    const interaction = await ai.interactions.create({
  model: "gemini-3.8-flash",
  input: prompt,
});

return interaction.output_text || "no output generated"
}      