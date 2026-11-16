//! Lists the flows of a project (default: the current directory) with the same
//! reader the Flows board uses. `cargo run --example list_flows -- <project>`.

fn main() {
    let cwd = std::env::args().nth(1).unwrap_or_else(|| ".".to_string());
    let cards = keryx_desktop_lib::flows::list_flows(std::path::Path::new(&cwd)).expect("list flows");
    println!("{} flows, {} with errors", cards.len(), cards.iter().filter(|c| c.error.is_some()).count());
    for card in cards.iter().take(3) {
        println!("{}", serde_json::to_string(card).unwrap());
    }
}
