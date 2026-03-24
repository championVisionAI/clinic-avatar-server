// questions.js - All question sets for patient intake

export const TREATMENTS = {
  DYSPORT: 'dysport',
  ABLATIVE_LASER: 'ablative_laser',
  CRYO_FACIAL: 'cryo_facial',
  STEM_CELL: 'stem_cell',
};

export const TREATMENT_LABELS = {
  [TREATMENTS.DYSPORT]: 'Dysport',
  [TREATMENTS.ABLATIVE_LASER]: 'Ablative Laser',
  [TREATMENTS.CRYO_FACIAL]: 'CryoFacial',
  [TREATMENTS.STEM_CELL]: 'Stem Cell Therapy',
};

export const GENERAL_QUESTIONS = [
  { id: 'g1', key: 'full_name', text: "What's your first and last name?" },
  { id: 'g2', key: 'date_of_birth', text: "What's your date of birth?" },
  { id: 'g3', key: 'prior_treatment', text: 'Have you had this treatment before?' },
  { id: 'g4', key: 'allergies', text: 'Do you have any allergies or bad reactions to medications or treatments?' },
  { id: 'g5', key: 'medications', text: 'Are you taking any medications right now?' },
  { id: 'g6', key: 'medical_history', text: 'Do you have any medical conditions or past surgeries?' },
  { id: 'g7', key: 'pregnancy', text: 'Are you pregnant or breastfeeding?' },
  { id: 'g8', key: 'new_health_concerns', text: "Do you have any new or serious health concerns you haven't talked to a doctor about yet?" },
];

export const TREATMENT_QUESTIONS = {
  [TREATMENTS.DYSPORT]: [
    { id: 'd1', key: 'skin_issues', text: 'Do you have any skin issues right now, like infections, cold sores, cuts, rashes, sunburn, or irritation?' },
    { id: 'd2', key: 'suspicious_lesions', text: 'Do you have any suspicious moles, lesions, or skin cancer in the area being treated, or anywhere on your body?' },
    { id: 'd3', key: 'neuromuscular', text: 'Do you have any neuromuscular conditions such as Guillain-Barré, Myasthenia Gravis, Bell\'s Palsy, or ALS?' },
    { id: 'd4', key: 'casein_allergy', text: 'Are you allergic to casein, which is a milk protein?' },
    { id: 'd5', key: 'heart_conditions', text: 'Do you have any uncontrolled heart conditions, like high blood pressure?' },
    { id: 'd6', key: 'chemo_radiation', text: 'Are you currently going through chemotherapy or radiation?' },
  ],
  [TREATMENTS.ABLATIVE_LASER]: [
    { id: 'al1', key: 'accutane', text: 'Have you taken Accutane, also known as isotretinoin, in the past 6 months?' },
    { id: 'al2', key: 'skin_issues', text: 'Do you have any skin issues right now, like infections, cold sores, cuts, rashes, sunburn, irritation, psoriasis, or eczema in the treatment area?' },
    { id: 'al3', key: 'suspicious_lesions', text: 'Do you have any suspicious moles, lesions, or skin cancer anywhere on your body?' },
    { id: 'al4', key: 'keloid_healing', text: 'Do you tend to get keloid scars from minor skin injuries, or have any conditions that affect healing?' },
    { id: 'al5', key: 'sun_exposure', text: 'Have you used self-tanner or had sun exposure in the treatment area in the past 4 weeks?' },
    { id: 'al6', key: 'photosensitive_meds', text: 'Have you taken any medications recently that make your skin sensitive to light, such as antibiotics or steroids?' },
    { id: 'al7', key: 'immune_suppression', text: 'Are you taking any medications that suppress your immune system, or do you have a weakened immune system?' },
    { id: 'al8', key: 'recent_injections', text: 'Have you had Botox or similar injections in the area in the past week, or fillers in the past 2 weeks?' },
    { id: 'al9', key: 'bleeding_disorders', text: 'Do you have any bleeding or blood clotting disorders, or have you taken blood thinners in the past week?' },
    { id: 'al10', key: 'chemo_radiation', text: 'Are you currently going through chemotherapy or radiation?' },
    { id: 'al11', key: 'vitiligo', text: 'Do you have vitiligo?' },
    { id: 'al12', key: 'tattoos', text: 'Do you have any tattoos or permanent makeup in the treatment area?' },
    { id: 'al13', key: 'skin_tone', text: 'How would you describe your skin tone — for example, light, olive, brown, or dark?' },
  ],
  [TREATMENTS.CRYO_FACIAL]: [
    { id: 'cf1', key: 'cold_sensitivity', text: 'Do you have any conditions that make you sensitive to cold, such as cold urticaria, Raynaud\'s, chilblains, or bad reactions to cold?' },
    { id: 'cf2', key: 'circulation_disorders', text: 'Do you have poor circulation or any blood disorders related to cold?' },
    { id: 'cf3', key: 'recent_treatments', text: 'Have you had Botox in the past 30 days, or fillers, PDO threads, or similar treatments in the area in the past 90 days?' },
    { id: 'cf4', key: 'skin_issues', text: 'Do you have any skin issues in the treatment area, like infections, cold sores, cuts, rashes, sunburn, irritation, psoriasis, or eczema?' },
    { id: 'cf5', key: 'metal_implants', text: 'Do you have any metal, silicone, or piercings in the treatment area — not including deep implants in bone?' },
    { id: 'cf6', key: 'nerve_issues', text: 'Do you have any nerve-related issues in the area, like numbness or diabetic neuropathy?' },
    { id: 'cf7', key: 'diabetes', text: 'Do you have uncontrolled diabetes or any endocrine disorders?' },
    { id: 'cf8', key: 'propylene_glycol', text: 'Are you allergic or sensitive to propylene glycol?' },
    { id: 'cf9', key: 'vitiligo', text: 'Do you have vitiligo?' },
  ],
  [TREATMENTS.STEM_CELL]: [
    { id: 'sc1', key: 'kidney_issues', text: 'Do you currently have kidney stones or any kidney or urinary issues?' },
    { id: 'sc2', key: 'cancer_chemo', text: 'Are you currently going through chemotherapy or radiation, or do you have a history of cancer?' },
    { id: 'sc3', key: 'heart_conditions', text: 'Do you have any uncontrolled heart conditions, like high blood pressure?' },
    { id: 'sc4', key: 'liver_problems', text: 'Do you have any serious liver problems?' },
    { id: 'sc5', key: 'pulmonary_edema', text: 'Do you currently have fluid in your lungs, such as pulmonary edema?' },
    { id: 'sc6', key: 'immune_system', text: 'Do you have a weakened immune system?' },
  ],
};

// Build a deduplicated, combined question list for selected treatments
export function buildQuestionSet(selectedTreatments) {
  const seenKeys = new Set();
  const combined = [];

  for (const treatment of selectedTreatments) {
    const qs = TREATMENT_QUESTIONS[treatment] || [];
    for (const q of qs) {
      if (!seenKeys.has(q.key)) {
        seenKeys.add(q.key);
        combined.push({ ...q, treatment });
      }
    }
  }

  return combined;
}

export const GREETING = `Hello and welcome! I'm your virtual health assistant. I'm going to ask you a series of questions to help gather important health information before your appointment. These questions are part of a routine screening process and are not intended to diagnose or treat any condition. Your answers will be securely collected and shared with a licensed healthcare provider, who will review your information. Please answer each question as accurately and honestly as possible. If you're unsure about anything, just do your best or let me know. This process is simply to ensure your safety and provide the best possible care. Let's get started.`;

export const CLOSING = `Thank you so much for answering all of my questions. Your responses have been collected. Please wait while we connect you with a provider who will go over your information shortly. Have a wonderful day!`;
