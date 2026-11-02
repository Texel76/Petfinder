const SUPABASE_URL = 'https://eiutcisunhsgsmucaqsx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_n4MzAlTwpufJBj2aLYzIbw_q74wGY9G';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- NUEVA FUNCIÓN DE FILTRADO CON IA ---
async function validarImagenConIA(archivo) {
    try {
        // 1. Convertir la imagen a Base64
        const base64Image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(archivo);
            reader.onload = () => resolve(reader.result);
            reader.onerror = error => reject(error);
        });

        // 2. Llamar a tu Edge Function en Supabase
        const respuesta = await fetch(`${SUPABASE_URL}/functions/v1/validar-imagen`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            },
            body: JSON.stringify({
                imagenBase64: base64Image,
                mimeType: archivo.type
            })
        });

        const resultado = await respuesta.json();
        return resultado; // Retorna { success: true } o { success: false, error: "motivo" }
    } catch (err) {
        console.error("Error al validar la imagen:", err);
        return { success: false, error: "No se pudo conectar con el sistema de validación." };
    }
}