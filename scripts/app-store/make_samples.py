"""Fictional sample PDFs used in the App Store screenshots. Nothing here is real data."""
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
import os
os.makedirs('samples', exist_ok=True)
W,H=letter
def letterpdf(path):
    c=canvas.Canvas(path,pagesize=letter)
    c.setTitle("Tenancy Confirmation")
    c.setFillColor(HexColor("#1d2a44")); c.rect(0,H-90,W,90,fill=1,stroke=0)
    c.setFillColor(HexColor("#ffffff")); c.setFont("Helvetica-Bold",20); c.drawString(54,H-55,"Maple Row Property Management")
    c.setFont("Helvetica",10); c.drawString(54,H-73,"412 Lakeview Crescent, Suite 300  ·  Toronto, ON  M4B 2K7")
    c.setFillColor(HexColor("#111111"))
    y=H-135
    c.setFont("Helvetica-Bold",15); c.drawString(54,y,"Tenancy Confirmation Letter"); y-=26
    c.setFont("Helvetica",10.5)
    lines=[("Date:","October 14, 2026"),("Tenant:","Jordan A. Whitfield"),("Unit:","1807 – 55 Harbourfront Way, Toronto, ON M5J 0B3"),
           ("Email:","jordan.whitfield@mailbox.example"),("Phone:","(416) 555-0187"),("SIN:","046 454 286"),("Account no.:","4417 1234 5678 9113")]
    for k,v in lines:
        c.setFont("Helvetica-Bold",10.5); c.drawString(54,y,k); c.setFont("Helvetica",10.5); c.drawString(150,y,v); y-=17
    y-=12
    body=["To whom it may concern,","",
     "This letter confirms that Jordan A. Whitfield has rented Unit 1807 at 55 Harbourfront Way",
     "since March 1, 2023. The current monthly rent is $2,450.00, paid on the first of each month",
     "by pre-authorized debit. The tenant's account is in good standing, with no late payments or",
     "outstanding balance as of the date of this letter.","",
     "The lease renews on February 28, 2027. Please direct any questions about this tenancy to our",
     "leasing office at leasing@maplerow.example or (416) 555-0142, Monday to Friday, 9 to 5.","",
     "Sincerely,"]
    for l in body: c.drawString(54,y,l); y-=16
    y-=34
    c.setFont("Helvetica-Bold",10.5); c.drawString(54,y,"Priya Natarajan"); y-=15
    c.setFont("Helvetica",10.5); c.drawString(54,y,"Leasing Manager, Maple Row Property Management"); y-=40
    c.setStrokeColor(HexColor("#cccccc")); c.line(54,y,W-54,y); y-=18
    c.setFont("Helvetica-Bold",11); c.drawString(54,y,"Payment summary (last 6 months)"); y-=20
    rows=[("Month","Amount","Method","Status")]+[(m,"$2,450.00","PAD ••9113","Paid") for m in ["May 2026","June 2026","July 2026","August 2026","September 2026","October 2026"]]
    for i,r in enumerate(rows):
        c.setFont("Helvetica-Bold" if i==0 else "Helvetica",10)
        for j,x in enumerate([54,200,320,440]): c.drawString(x,y,r[j])
        y-=16
    c.setFont("Helvetica",8); c.setFillColor(HexColor("#777777")); c.drawString(54,40,"Maple Row Property Management  ·  This is a fictional sample document.")
    c.showPage()
    # page 2
    c.setFont("Helvetica-Bold",15); c.setFillColor(HexColor("#111111")); c.drawString(54,H-80,"Schedule A – Building Rules")
    c.setFont("Helvetica",10.5); y=H-110
    for i in range(1,19):
        c.drawString(54,y,f"{i}. Residents agree to keep common areas clear and to report maintenance issues promptly."); y-=22
    c.showPage(); c.save()
def simple(path,title,color,pages=2):
    c=canvas.Canvas(path,pagesize=letter)
    for p in range(pages):
        c.setFillColor(HexColor(color)); c.rect(0,H-70,W,70,fill=1,stroke=0)
        c.setFillColor(HexColor("#ffffff")); c.setFont("Helvetica-Bold",18); c.drawString(54,H-45,title)
        c.setFillColor(HexColor("#222222")); c.setFont("Helvetica",11); y=H-110
        for i in range(24): c.drawString(54,y,"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor."); y-=20
        c.setFont("Helvetica",9); c.drawString(W/2-10,30,str(p+1)); c.showPage()
    c.save()
letterpdf("samples/Tenancy Confirmation.pdf")
simple("samples/Offer Letter.pdf","Offer of Employment","#2f5d50",2)
simple("samples/Pay Stub October.pdf","Pay Statement – October 2026","#6b3d7a",1)
simple("samples/Reference Letter.pdf","Letter of Reference","#8a5a12",3)

def packet(path):
    c=canvas.Canvas(path,pagesize=letter)
    cols=["#1d2a44","#2f5d50","#6b3d7a","#8a5a12","#7a2e2e","#24527a","#3f4a3c","#5b4b8a","#1d2a44"]
    titles=["Cover Letter","Résumé","Résumé (cont.)","Transcript","Reference – Dr. Lin","Reference – M. Okafor","Portfolio","Portfolio (cont.)","Declaration"]
    for i,(col,t) in enumerate(zip(cols,titles)):
        c.setFillColor(HexColor(col)); c.rect(0,H-120,W,120,fill=1,stroke=0)
        c.setFillColor(HexColor("#ffffff")); c.setFont("Helvetica-Bold",30); c.drawString(54,H-75,t)
        y=H-170
        for k in range(22):
            c.setFillColor(HexColor("#c9ccd1")); c.roundRect(54,y,(W-108)*(0.55+0.45*((k*37+i*11)%10)/10),9,4,fill=1,stroke=0); y-=24
        c.setFillColor(HexColor("#555555")); c.setFont("Helvetica",11); c.drawCentredString(W/2,36,str(i+1)); c.showPage()
    c.save()
packet("samples/Application Packet.pdf")
