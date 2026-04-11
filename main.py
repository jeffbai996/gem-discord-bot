import os
import discord
from dotenv import load_dotenv
from google import genai

# Load environment variables
load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not DISCORD_TOKEN or not GEMINI_API_KEY:
    print("Error: DISCORD_TOKEN and GEMINI_API_KEY must be set in .env")
    exit(1)

# Initialize Gemini Client
client = genai.Client(api_key=GEMINI_API_KEY)
MODEL_ID = "gemini-2.5-flash"

# Set up Discord intents
intents = discord.Intents.default()
intents.message_content = True  # Required to read message content

class GeminiBot(discord.Client):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    async def on_ready(self):
        print(f'Logged in as {self.user} (ID: {self.user.id})')
        print('------')

    async def on_message(self, message):
        # Ignore messages from the bot itself
        if message.author == self.user:
            return

        # Check if the message is in a thread
        is_in_thread = isinstance(message.channel, discord.Thread)
        
        # Check if the bot was mentioned
        bot_mentioned = self.user in message.mentions

        # 1. If we are in a regular channel and mentioned, create a thread
        if not is_in_thread and bot_mentioned:
            # Remove the bot mention from the prompt
            user_prompt = message.clean_content.replace(f'@{self.user.display_name}', '').strip()
            if not user_prompt:
                user_prompt = "Hello!"

            thread_name = f"Chat with {message.author.display_name}"
            # Create a thread from the message
            thread = await message.create_thread(name=thread_name, auto_archive_duration=60)
            
            async with thread.typing():
                try:
                    response = client.models.generate_content(
                        model=MODEL_ID,
                        contents=[{"role": "user", "parts": [{"text": user_prompt}]}]
                    )
                    await self.send_long_message(thread, response.text)
                except Exception as e:
                    await thread.send(f"Error: {e}")
            return

        # 2. If we are in a thread, respond if we are the thread owner or mentioned
        if is_in_thread and (message.channel.owner_id == self.user.id or bot_mentioned):
            async with message.channel.typing():
                try:
                    # Fetch conversation history from the thread
                    # We limit to last 30 messages to fit context and avoid rate limits
                    history = []
                    async for msg in message.channel.history(limit=30, oldest_first=True):
                        if not msg.clean_content and not msg.attachments:
                            continue
                            
                        # Determine role: "model" for bot, "user" for anyone else
                        role = "model" if msg.author == self.user else "user"
                        
                        text = msg.clean_content
                        # If it's a user message, prefix their name if multiple people talk
                        if role == "user":
                            text = f"{msg.author.display_name}: {text}"
                            
                        history.append({"role": role, "parts": [{"text": text}]})
                    
                    if not history:
                        return
                        
                    response = client.models.generate_content(
                        model=MODEL_ID,
                        contents=history
                    )
                    
                    await self.send_long_message(message.channel, response.text)
                except Exception as e:
                    await message.reply(f"Error: {e}")

    async def send_long_message(self, channel, text):
        """Splits long messages to comply with Discord's 2000 character limit."""
        if len(text) <= 2000:
            await channel.send(text)
            return

        # Simple chunking by character limit
        chunks = [text[i:i+1990] for i in range(0, len(text), 1990)]
        for chunk in chunks:
            await channel.send(chunk)

bot = GeminiBot(intents=intents)

if __name__ == '__main__':
    bot.run(DISCORD_TOKEN)