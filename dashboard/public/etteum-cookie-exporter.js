/**
 * Etteum Pool — 1-Click Cookie Exporter Bookmarklet
 * Drag this to your bookmarks bar, then click it on gemini.google.com / chat.deepseek.com / chat.qwen.ai / chat.z.ai
 * It will copy the cookie/token to clipboard in format ready to paste into Dashboard → Accounts → Gemini/DeepSeek/Qwen/ZAI Web
 *
 * Bookmarklet code (minified for bookmark URL):
 * javascript:(async()=>{const s=location.hostname;let v="",n="";if(s.includes("gemini.google.com")){const m=document.cookie.match(/__Secure-1PSID=([^;]+)/);v=m?`__Secure-1PSID=${m[1]}`:document.cookie; n="Gemini Web (__Secure-1PSID)";}else if(s.includes("chat.deepseek.com")){v=localStorage.getItem("userToken")||""; if(v.startsWith('"'))try{v=JSON.parse(v)}catch{} n="DeepSeek Web (userToken)"; if(v) v=`userToken=${v}`;}else if(s.includes("chat.qwen.ai")||s.includes("qwen.ai")){v=document.cookie; n="Qwen Web (Cookie)";}else if(s.includes("chat.z.ai")){v=localStorage.getItem("token")||localStorage.getItem("access_token")||""; n="Z.AI Web (token)"; if(v) v=`token=${v}`;}else{v=document.cookie; n="Generic Cookie";} if(!v){alert("No cookie/token found for "+s);return;} await navigator.clipboard.writeText(v); alert(n+" copied! Paste into Etteum Dashboard → Accounts → "+n.split(" (")[0]);})()
 */
(function () {
  const hostname = location.hostname;
  let value = "";
  let name = "";
  let help = "";

  if (hostname.includes("gemini.google.com")) {
    const match = document.cookie.match(/__Secure-1PSID=([^;]+)/);
    const psid = match ? match[1] : "";
    const psidts = (document.cookie.match(/__Secure-1PSIDTS=([^;]+)/) || [])[1] || "";
    const psidcc = (document.cookie.match(/__Secure-1PSIDCC=([^;]+)/) || [])[1] || "";
    if (psid) {
      value = `__Secure-1PSID=${psid}` + (psidts ? `; __Secure-1PSIDTS=${psidts}` : "") + (psidcc ? `; __Secure-1PSIDCC=${psidcc}` : "");
      // Also include full cookie as fallback
      if (!psidts) value = document.cookie;
    } else {
      value = document.cookie;
    }
    name = "Gemini Web";
    help = "Paste into Dashboard → Accounts → Gemini Web → Single → Password = cookie";
  } else if (hostname.includes("chat.deepseek.com")) {
    let token = localStorage.getItem("userToken") || "";
    if (token.startsWith('"')) {
      try { token = JSON.parse(token); } catch {}
    }
    // token may be JSON string like {"token":"..."}
    if (token && token.includes("{")) {
      try { const obj = JSON.parse(token); token = obj.token || obj.access_token || token; } catch {}
    }
    value = token ? `userToken=${token}` : document.cookie;
    name = "DeepSeek Web";
    help = "Paste token into Dashboard → DeepSeek Web → Password";
  } else if (hostname.includes("chat.qwen.ai") || hostname.includes("qwen.ai")) {
    value = document.cookie;
    name = "Qwen Web";
    help = "Paste Cookie header into Dashboard → Qwen Web";
  } else if (hostname.includes("chat.z.ai") || hostname.includes("z.ai")) {
    let token = localStorage.getItem("token") || localStorage.getItem("access_token") || localStorage.getItem("authToken") || "";
    if (!token) {
      // Try to find token in localStorage keys
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.toLowerCase().includes("token")) {
          const v = localStorage.getItem(k);
          if (v && v.length > 20) { token = v; break; }
        }
      }
    }
    value = token ? `token=${token}` : document.cookie;
    name = "Z.AI Web";
    help = "Paste token into Dashboard → Z.AI Web";
  } else {
    value = document.cookie;
    name = "Generic";
    help = "Copied full Cookie header";
  }

  if (!value || value.length < 5) {
    alert("⚠️ No cookie/token found for " + hostname + "\n\nMake sure you're logged in and try again.");
    return;
  }

  navigator.clipboard.writeText(value).then(() => {
    const preview = value.length > 80 ? value.slice(0, 80) + "..." : value;
    alert(`✅ ${name} cookie/token copied!\n\n${help}\n\nPreview: ${preview}\n\nNow paste into Etteum Dashboard → Accounts → ${name}`);
  }).catch(() => {
    prompt(`Copy this ${name} cookie/token manually (Ctrl+C):`, value);
  });
})();
