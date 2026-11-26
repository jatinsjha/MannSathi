import {el,button} from "./admin-views.js";

export function mountMfa(parent, verifyAccess, currentAccount) {
    const box=el("section",null,"admin-box admin-mfa"), title=el("h2","Verify your identity");
    const copy=el("p","Use an authenticator app to open student usage records and administrative controls.");
    const status=el("p"); status.setAttribute("role","status");
    const body=el("div");
    box.append(title,copy,body,status); parent.replaceChildren(box);
    const current=()=>box.isConnected && currentAccount();
    let newFactor, client, verifying=false;
    const displayCode=(factorId, enrollment) => {
        if (!current()) return;
        const form=el("form"), label=el("label","Six-digit code"), input=el("input");
        input.type="text"; input.inputMode="numeric"; input.autocomplete="one-time-code";
        input.pattern="[0-9]{6}"; input.maxLength=6; input.required=true; label.append(input);
        if (enrollment) {
            const secret=el("code",enrollment.secret);
            form.append(el("p","Scan this code in your authenticator, or enter the setup key manually."));
            if (enrollment.qr_code?.startsWith("data:image/svg+xml")) {
                const qr=el("img"); qr.alt="Authenticator setup QR code"; qr.src=enrollment.qr_code; qr.width=168; qr.height=168; form.append(qr);
            }
            form.append(el("p","Setup key"),secret);
        }
        const submit=el("button","Verify","primary-button"); submit.type="submit";
        form.append(label,submit); body.replaceChildren(form); input.focus();
        form.addEventListener("submit",async e=>{
            e.preventDefault(); if(submit.disabled || !current() || !form.reportValidity()) return;
            submit.disabled=true; verifying=true; status.textContent="Verifying…";
            try {
                const {error}=await client.auth.mfa.challengeAndVerify({factorId,code:input.value});
                if(error) throw error;
                newFactor=null;
                if(current()) {body.replaceChildren(); await verifyAccess();}
            } catch {
                if(current()) {status.textContent="Verification failed. Check the current code and your connection, then try again.";input.value="";input.focus();}
            } finally {verifying=false; submit.disabled=false;}
        });
    };
    async function start() {
        begin.disabled=true; status.textContent="Checking your authenticator…";
        try {
            client=await window.supabaseReady;
            const factors=await client.auth.mfa.listFactors();
            if(factors.error) throw factors.error;
            if(!current()) return;
            const verified=(factors.data.totp || []).filter(f=>f.status==="verified");
            status.textContent="";
            if(verified.length===1) return displayCode(verified[0].id);
            if(verified.length>1) {
                body.replaceChildren(el("p","Choose the authenticator to use."));
                verified.forEach((f,i)=>body.append(button(f.friendly_name || "Authenticator "+(i+1),()=>displayCode(f.id))));
                return;
            }
            // Enrollment starts only after this administrator explicitly selects setup.
            const enroll=button("Set up an authenticator",async()=>{
                enroll.disabled=true;status.textContent="Preparing setup…";
                try {
                    const result=await client.auth.mfa.enroll({factorType:"totp",issuer:"MannSathi"});
                    if(result.error) throw result.error;
                    newFactor=result.data.id;
                    if(!current()) {dispose();return;}
                    status.textContent="";displayCode(newFactor,result.data.totp);
                } catch {if(current()) status.textContent="Setup could not start. Check your connection or contact support.";}
                finally {enroll.disabled=false;}
            });
            body.replaceChildren(el("p","Add MannSathi to an authenticator app, then verify its six-digit code."),enroll);
            enroll.focus();
        } catch {if(current()) status.textContent="Could not load your authenticators. Try again or contact support.";}
        finally {begin.disabled=false;}
    }
    const begin=button("Continue",start);body.append(begin);
    function dispose() {
        box.remove();
        if(newFactor && !verifying && currentAccount() && client) {
            const id=newFactor;newFactor=null;
            client.auth.mfa.unenroll({factorId:id}).catch(()=>{});
        }
    }
    return dispose;
}
